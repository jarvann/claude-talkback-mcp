import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

export type Platform = "wsl" | "windows" | "macos" | "linux" | "unknown";
export type Engine = "sapi" | "elevenlabs";

export interface Voice {
  name: string;
  id?: string; // ElevenLabs voice_id (SAPI voices have no id)
  culture?: string;
  gender?: string;
}

function detectPlatform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    try {
      if (readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft")) {
        return "wsl";
      }
    } catch {
      /* /proc/version not readable — treat as plain linux */
    }
    return "linux";
  }
  return "unknown";
}

export const PLATFORM = detectPlatform();
const POWERSHELL = PLATFORM === "wsl" ? "powershell.exe" : "powershell";

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const envInt = (name: string, def: number, lo: number, hi: number) =>
  clampInt(parseInt(process.env[name] ?? "", 10) || def, lo, hi);
const envFloat = (name: string, def: number, lo: number, hi: number) => {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};

const RATE = envInt("TALKBACK_RATE", 1, -10, 10);
const MAX_CHARS = envInt("TALKBACK_MAX_CHARS", 600, 80, 4000);

// ElevenLabs config (key is Bring-Your-Own via env).
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
const ELEVEN_FORMAT = process.env.ELEVENLABS_FORMAT || "mp3_44100_128";
const ELEVEN_DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || "cgSgspJ2msm6clMCkdW9"; // Jessica (premade, free-tier)
const ELEVEN_SPEED = envFloat("ELEVENLABS_SPEED", 0.9, 0.7, 1.2); // <1 = slower, less rushed
const ELEVEN_STABILITY = envFloat("ELEVENLABS_STABILITY", 0.5, 0, 1);
const ELEVEN_SIMILARITY = envFloat("ELEVENLABS_SIMILARITY", 0.75, 0, 1);

const hasElevenKey = () => !!process.env.ELEVENLABS_API_KEY;

// Mutable runtime state.
let engine: Engine =
  (process.env.TALKBACK_ENGINE as Engine) || (hasElevenKey() ? "elevenlabs" : "sapi");
let sapiVoice: string | null = process.env.TALKBACK_VOICE?.trim() || null;
let elevenVoiceId: string = ELEVEN_DEFAULT_VOICE;

/** Strip markdown/URLs/code so speech stays clean, and cap length as a safety net. */
export function tidyForSpeech(raw: string): string {
  let t = raw ?? "";
  t = t.replace(/```[\s\S]*?```/g, " "); // drop fenced code blocks entirely
  t = t.replace(/`([^`]*)`/g, "$1"); // inline code -> its text
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // [text](url) -> text
  t = t.replace(/https?:\/\/\S+/g, "a link"); // bare URLs
  t = t.replace(/[*_#>`]+/g, " "); // leftover markdown markers
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…";
  return t;
}

// ---- process spawning helpers -----------------------------------------------

interface Spec {
  cmd: string;
  args: string[];
}

function rateToWpm(rate: number): number {
  return clampInt(180 + rate * 20, 100, 400);
}

/** SAPI: reads the text to speak from stdin (avoids all quoting/escaping issues). */
function sapiSpec(voice: string | null): Spec | null {
  switch (PLATFORM) {
    case "wsl":
    case "windows": {
      const select = voice ? `try { $s.SelectVoice('${voice.replace(/'/g, "''")}') } catch {}; ` : "";
      const ps =
        "Add-Type -AssemblyName System.Speech; " +
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
        select +
        `$s.Rate = ${RATE}; ` +
        "$s.Speak([Console]::In.ReadToEnd())";
      return { cmd: POWERSHELL, args: ["-NoProfile", "-Command", ps] };
    }
    case "macos": {
      const args = ["-r", String(rateToWpm(RATE)), "-f", "-"];
      if (voice) args.unshift("-v", voice);
      return { cmd: "say", args };
    }
    case "linux": {
      const args = ["--stdin", "-s", String(rateToWpm(RATE))];
      if (voice) args.push("-v", voice);
      return { cmd: "espeak", args };
    }
    default:
      return null;
  }
}

// Reads MP3 bytes from stdin into a temp file and plays them via Windows
// Media Player, blocking for the clip's natural duration. Killing the process
// (barge-in) stops playback immediately.
const MP3_PLAYER_PS = [
  "$ErrorActionPreference='Stop'",
  "$mp3=[System.IO.Path]::GetTempFileName()+'.mp3'",
  "$fs=[System.IO.File]::Create($mp3)",
  "[Console]::OpenStandardInput().CopyTo($fs)",
  "$fs.Close()",
  "Add-Type -AssemblyName PresentationCore",
  "$pl=New-Object System.Windows.Media.MediaPlayer",
  "$pl.Open([System.Uri]$mp3)",
  "$n=0; while(-not $pl.NaturalDuration.HasTimeSpan -and $n -lt 150){Start-Sleep -Milliseconds 20;$n++}",
  "$ms=if($pl.NaturalDuration.HasTimeSpan){[int]$pl.NaturalDuration.TimeSpan.TotalMilliseconds}else{6000}",
  "$pl.Play(); Start-Sleep -Milliseconds ($ms+500)",
  "$pl.Stop(); $pl.Close()",
  "Remove-Item $mp3 -ErrorAction SilentlyContinue",
].join("; ");

function mp3PlayerSpec(): Spec | null {
  if (PLATFORM === "wsl" || PLATFORM === "windows") {
    return { cmd: POWERSHELL, args: ["-NoProfile", "-Command", MP3_PLAYER_PS] };
  }
  if (PLATFORM === "macos") return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-"] };
  if (PLATFORM === "linux") return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-"] };
  return null;
}

// ---- playback queue (non-blocking, interruptible) ---------------------------

let playing = false;
let currentChild: ChildProcess | null = null;
let currentAbort: AbortController | null = null;
const queue: Array<{ text: string; voice?: string }> = [];

function runPlayer(spec: Spec | null, input: Buffer, abort: AbortController): Promise<void> {
  return new Promise((resolve) => {
    if (!spec || abort.signal.aborted) return resolve();
    let child: ChildProcess;
    try {
      child = spawn(spec.cmd, spec.args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch (err) {
      process.stderr.write(`[talkback] spawn failed: ${(err as Error).message}\n`);
      return resolve();
    }
    currentChild = child;
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      abort.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    child.on("error", (err: Error) => {
      process.stderr.write(`[talkback] player error: ${err.message}\n`);
      done();
    });
    child.on("exit", done);
    child.stdin?.end(input);
  });
}

type ElevenErrorCode =
  | "no_key"
  | "quota_exceeded"
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "http_error"
  | "network";

class ElevenError extends Error {
  code: ElevenErrorCode;
  constructor(message: string, code: ElevenErrorCode) {
    super(message);
    this.code = code;
  }
}

// A "fatal" error means retrying ElevenLabs this session is pointless (out of
// characters, bad/missing key) — so we permanently drop to SAPI. Transient or
// voice-specific errors (rate limit, a tier-locked voice) only fall back for
// the one line and keep ElevenLabs active for the next.
function isFatalElevenError(err: unknown): boolean {
  return (
    err instanceof ElevenError &&
    (err.code === "quota_exceeded" || err.code === "unauthorized" || err.code === "no_key")
  );
}

function fallbackNotice(err: unknown): string {
  const code = err instanceof ElevenError ? err.code : "network";
  if (code === "quota_exceeded")
    return "Heads up — ElevenLabs is out of characters for now, so I'm switching to the local voice.";
  if (code === "no_key" || code === "unauthorized")
    return "The ElevenLabs key isn't working, so I'm switching to the local voice.";
  return "ElevenLabs hit a snag, switching to the local voice.";
}

async function fetchEleven(text: string, voiceId: string, signal: AbortSignal): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new ElevenError("ELEVENLABS_API_KEY not set", "no_key");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${ELEVEN_FORMAT}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: {
          stability: ELEVEN_STABILITY,
          similarity_boost: ELEVEN_SIMILARITY,
          speed: ELEVEN_SPEED,
        },
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ElevenError(`network error: ${(err as Error).message}`, "network");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detailStatus = "";
    try {
      detailStatus = JSON.parse(body)?.detail?.status ?? "";
    } catch {
      /* body wasn't JSON */
    }
    const code: ElevenErrorCode =
      detailStatus === "quota_exceeded"
        ? "quota_exceeded"
        : res.status === 401
          ? "unauthorized"
          : res.status === 402
            ? "payment_required"
            : res.status === 429
              ? "rate_limited"
              : "http_error";
    throw new ElevenError(`HTTP ${res.status} ${body.slice(0, 160)}`, code);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function pump(): Promise<void> {
  if (playing) return;
  playing = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    const abort = new AbortController();
    currentAbort = abort;
    try {
      if (engine === "elevenlabs") {
        let audio: Buffer | null = null;
        try {
          audio = await fetchEleven(item.text, item.voice || elevenVoiceId, abort.signal);
        } catch (err) {
          if (abort.signal.aborted) continue;
          const fatal = isFatalElevenError(err);
          process.stderr.write(
            `[talkback] ElevenLabs failed (${(err as Error).message})` +
              (fatal ? " — auto-switching to SAPI for the session\n" : "; SAPI for this line\n"),
          );
          if (fatal) {
            engine = "sapi"; // stay on SAPI; stop retrying the exhausted/broken API
            await runPlayer(sapiSpec(null), Buffer.from(fallbackNotice(err), "utf8"), abort);
          }
        }
        if (abort.signal.aborted) continue;
        if (audio) {
          await runPlayer(mp3PlayerSpec(), audio, abort);
        } else {
          await runPlayer(sapiSpec(null), Buffer.from(item.text, "utf8"), abort);
        }
      } else {
        await runPlayer(sapiSpec(item.voice ?? sapiVoice), Buffer.from(item.text, "utf8"), abort);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        process.stderr.write(`[talkback] playback error: ${(err as Error).message}\n`);
      }
    } finally {
      currentChild = null;
      currentAbort = null;
    }
  }
  playing = false;
}

export interface SpeakOptions {
  interrupt?: boolean;
  voice?: string; // SAPI voice name, or resolved ElevenLabs voice_id
}

/** Queue a line to be spoken. Returns immediately (non-blocking). */
export function speak(raw: string, opts: SpeakOptions = {}): { spoken: string; skipped: boolean } {
  const text = tidyForSpeech(raw);
  if (!text) return { spoken: "", skipped: true };
  if (opts.interrupt) stopSpeaking();
  queue.push({ text, voice: opts.voice });
  void pump();
  return { spoken: text, skipped: false };
}

/** Cut off any in-progress speech and clear the queue. */
export function stopSpeaking(): void {
  queue.length = 0;
  currentAbort?.abort();
  if (currentChild) {
    try {
      currentChild.kill();
    } catch {
      /* already gone */
    }
    currentChild = null;
  }
}

// ---- engine + voice management ----------------------------------------------

export function getEngine(): Engine {
  return engine;
}

/** Switch engine at runtime. Returns false for an unknown engine name. */
export function setEngine(e: string): boolean {
  if (e !== "sapi" && e !== "elevenlabs") return false;
  engine = e;
  return true;
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("exit", (code: number | null) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
    );
  });
}

let elevenVoiceCache: Voice[] | null = null;

async function listSapiVoices(): Promise<Voice[]> {
  if (PLATFORM !== "wsl" && PLATFORM !== "windows") return [];
  const ps =
    "Add-Type -AssemblyName System.Speech; " +
    "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
    "ForEach-Object { $i = $_.VoiceInfo; \"$($i.Name)|$($i.Culture)|$($i.Gender)\" }";
  const out = await runCapture(POWERSHELL, ["-NoProfile", "-Command", ps]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, culture, gender] = l.split("|");
      return { name, culture, gender };
    });
}

async function listElevenVoices(): Promise<Voice[]> {
  if (!hasElevenKey()) return [];
  if (elevenVoiceCache) return elevenVoiceCache;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { voices?: Array<{ name: string; voice_id: string }> };
  elevenVoiceCache = (data.voices || []).map((v) => ({ name: v.name, id: v.voice_id }));
  return elevenVoiceCache;
}

/** Enumerate voices for the active engine. */
export async function listVoices(): Promise<Voice[]> {
  try {
    return engine === "elevenlabs" ? await listElevenVoices() : await listSapiVoices();
  } catch (err) {
    process.stderr.write(`[talkback] listVoices failed: ${(err as Error).message}\n`);
    return [];
  }
}

function matchVoice(voices: Voice[], query: string): Voice | null {
  const q = query.trim().toLowerCase();
  return (
    voices.find((v) => v.name.toLowerCase() === q || v.id?.toLowerCase() === q) ??
    voices.find((v) => v.name.toLowerCase().includes(q)) ??
    null
  );
}

/** Resolve a query to a concrete voice token for the active engine WITHOUT changing the default. */
export async function resolveVoice(query: string): Promise<string | null> {
  const match = matchVoice(await listVoices(), query);
  if (!match) return null;
  return engine === "elevenlabs" ? match.id ?? null : match.name;
}

/**
 * Set the active voice for the current engine. Accepts an exact name/id or a
 * case-insensitive partial name. Returns the resolved full name, or null.
 */
export async function setVoice(query: string): Promise<string | null> {
  const match = matchVoice(await listVoices(), query);
  if (!match) return null;
  if (engine === "elevenlabs") {
    if (!match.id) return null;
    elevenVoiceId = match.id;
  } else {
    sapiVoice = match.name;
  }
  return match.name;
}

export function getActiveVoice(): string | null {
  return engine === "elevenlabs" ? elevenVoiceId : sapiVoice;
}

export function backendInfo(): string {
  if (engine === "elevenlabs") {
    return `elevenlabs (voice=${elevenVoiceId}, model=${ELEVEN_MODEL}, key=${hasElevenKey() ? "set" : "MISSING"})`;
  }
  return `sapi (voice=${sapiVoice ?? "system default"}, rate=${RATE}) on ${PLATFORM}`;
}
