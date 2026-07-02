import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function detectPlatform() {
    if (process.platform === "win32")
        return "windows";
    if (process.platform === "darwin")
        return "macos";
    if (process.platform === "linux") {
        try {
            if (readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft")) {
                return "wsl";
            }
        }
        catch {
            /* /proc/version not readable — treat as plain linux */
        }
        return "linux";
    }
    return "unknown";
}
export const PLATFORM = detectPlatform();
const POWERSHELL = PLATFORM === "wsl" ? "powershell.exe" : "powershell";
const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const envInt = (name, def, lo, hi) => clampInt(parseInt(process.env[name] ?? "", 10) || def, lo, hi);
const envFloat = (name, def, lo, hi) => {
    const v = parseFloat(process.env[name] ?? "");
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};
const RATE = envInt("TALKBACK_RATE", 1, -10, 10);
const MAX_CHARS = envInt("TALKBACK_MAX_CHARS", 600, 80, 4000);
// ElevenLabs config (key is Bring-Your-Own via env).
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5"; // fastest (~75ms), half-price
const ELEVEN_FORMAT = process.env.ELEVENLABS_FORMAT || "mp3_44100_128";
const ELEVEN_FALLBACK_VOICE = "cgSgspJ2msm6clMCkdW9"; // Jessica — last resort if auto-pick can't run
const ELEVEN_ENV_VOICE = process.env.ELEVENLABS_VOICE_ID?.trim() || null; // explicit per-repo pin
const ELEVEN_SPEED = envFloat("ELEVENLABS_SPEED", 0.9, 0.7, 1.2); // <1 = slower, less rushed
const ELEVEN_STABILITY = envFloat("ELEVENLABS_STABILITY", 0.5, 0, 1);
const ELEVEN_SIMILARITY = envFloat("ELEVENLABS_SIMILARITY", 0.75, 0, 1);
const hasElevenKey = () => !!process.env.ELEVENLABS_API_KEY;
// Mutable runtime state.
let engine = process.env.TALKBACK_ENGINE || (hasElevenKey() ? "elevenlabs" : "sapi");
let sapiVoice = process.env.TALKBACK_VOICE?.trim() || null;
let elevenVoiceId = ELEVEN_ENV_VOICE ?? ELEVEN_FALLBACK_VOICE;
// ---- per-repo voice persistence ---------------------------------------------
// Each repo (keyed by the directory Claude Code launched us in) remembers the
// voice it was assigned, so it keeps the same "teammate" voice across restarts.
const STATE_DIR = process.env.TALKBACK_STATE_DIR || join(homedir(), ".claude-talkback");
const STATE_FILE = join(STATE_DIR, "repos.json");
const REPO_ID = process.env.TALKBACK_REPO_ID || process.cwd();
function loadRepoState() {
    try {
        return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    }
    catch {
        return {};
    }
}
function loadRepoVoice(forEngine) {
    return loadRepoState()[`${forEngine}:${REPO_ID}`];
}
function saveRepoVoice(forEngine, voice) {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        const state = loadRepoState();
        state[`${forEngine}:${REPO_ID}`] = voice;
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
    catch (err) {
        process.stderr.write(`[talkback] could not persist voice: ${err.message}\n`);
    }
}
const pickRandom = (arr) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
// Voices safe to auto-assign: on ElevenLabs, only free-tier "premade" voices
// (professional/library voices 402 on free plans). SAPI: all installed voices.
function usablePool(voices) {
    return engine === "elevenlabs"
        ? voices.filter((v) => (v.category ?? "premade") === "premade" && v.id)
        : voices;
}
const voiceToken = (v, forEngine) => forEngine === "elevenlabs" ? v.id ?? "" : v.name;
/** Voice tokens already assigned to OTHER repos for a given engine. */
function usedVoicesForEngine(forEngine) {
    const mine = `${forEngine}:${REPO_ID}`;
    const prefix = `${forEngine}:`;
    const used = new Set();
    for (const [key, token] of Object.entries(loadRepoState())) {
        if (key.startsWith(prefix) && key !== mine)
            used.add(token);
    }
    return used;
}
/** Prefer a voice no other repo is using, so projects stay distinct teammates. */
function pickFreshVoice(pool, forEngine) {
    const used = usedVoicesForEngine(forEngine);
    const fresh = pool.filter((v) => !used.has(voiceToken(v, forEngine)));
    return pickRandom(fresh.length ? fresh : pool);
}
let initialized = false;
/**
 * On first use in a repo: reuse the voice saved for this repo, or (if none)
 * randomly pick one and save it. An explicit env pin always wins and is never
 * overwritten. Safe to call repeatedly — only the first call does work.
 */
export async function ensureInitialized() {
    if (initialized)
        return;
    initialized = true;
    try {
        if (engine === "elevenlabs") {
            if (ELEVEN_ENV_VOICE || !hasElevenKey())
                return; // pinned, or can't list — keep current
            const saved = loadRepoVoice("elevenlabs");
            if (saved) {
                elevenVoiceId = saved;
                return;
            }
            const pick = pickFreshVoice(usablePool(await listVoices()), "elevenlabs");
            if (pick?.id) {
                elevenVoiceId = pick.id;
                saveRepoVoice("elevenlabs", pick.id);
                process.stderr.write(`[talkback] auto-assigned this repo the voice "${pick.name}" (${pick.gender ?? "?"})\n`);
            }
        }
        else {
            if (sapiVoice)
                return; // explicit env voice — keep
            const saved = loadRepoVoice("sapi");
            if (saved) {
                sapiVoice = saved;
                return;
            }
            const pick = pickFreshVoice(usablePool(await listVoices()), "sapi");
            if (pick) {
                sapiVoice = pick.name;
                saveRepoVoice("sapi", pick.name);
            }
        }
    }
    catch (err) {
        process.stderr.write(`[talkback] voice init failed: ${err.message}\n`);
    }
}
/** Strip markdown/URLs/code so speech stays clean, and cap length as a safety net. */
export function tidyForSpeech(raw) {
    let t = raw ?? "";
    t = t.replace(/```[\s\S]*?```/g, " "); // drop fenced code blocks entirely
    t = t.replace(/`([^`]*)`/g, "$1"); // inline code -> its text
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // [text](url) -> text
    t = t.replace(/https?:\/\/\S+/g, "a link"); // bare URLs
    t = t.replace(/[*_#>`]+/g, " "); // leftover markdown markers
    t = t.replace(/\s+/g, " ").trim();
    if (t.length > MAX_CHARS)
        t = t.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…";
    return t;
}
function rateToWpm(rate) {
    return clampInt(180 + rate * 20, 100, 400);
}
/** SAPI: reads the text to speak from stdin (avoids all quoting/escaping issues). */
function sapiSpec(voice) {
    switch (PLATFORM) {
        case "wsl":
        case "windows": {
            const select = voice ? `try { $s.SelectVoice('${voice.replace(/'/g, "''")}') } catch {}; ` : "";
            const ps = "Add-Type -AssemblyName System.Speech; " +
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
                select +
                `$s.Rate = ${RATE}; ` +
                "$s.Speak([Console]::In.ReadToEnd())";
            return { cmd: POWERSHELL, args: ["-NoProfile", "-Command", ps] };
        }
        case "macos": {
            const args = ["-r", String(rateToWpm(RATE)), "-f", "-"];
            if (voice)
                args.unshift("-v", voice);
            return { cmd: "say", args };
        }
        case "linux": {
            const args = ["--stdin", "-s", String(rateToWpm(RATE))];
            if (voice)
                args.push("-v", voice);
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
function mp3PlayerSpec() {
    if (PLATFORM === "wsl" || PLATFORM === "windows") {
        return { cmd: POWERSHELL, args: ["-NoProfile", "-Command", MP3_PLAYER_PS] };
    }
    if (PLATFORM === "macos")
        return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-"] };
    if (PLATFORM === "linux")
        return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-"] };
    return null;
}
// ---- playback queue (non-blocking, interruptible) ---------------------------
let playing = false;
let currentChild = null;
let currentAbort = null;
const queue = [];
function runPlayer(spec, input, abort) {
    return new Promise((resolve) => {
        if (!spec || abort.signal.aborted)
            return resolve();
        let child;
        try {
            child = spawn(spec.cmd, spec.args, { stdio: ["pipe", "ignore", "ignore"] });
        }
        catch (err) {
            process.stderr.write(`[talkback] spawn failed: ${err.message}\n`);
            return resolve();
        }
        currentChild = child;
        const onAbort = () => {
            try {
                child.kill();
            }
            catch {
                /* already gone */
            }
        };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        const done = () => {
            abort.signal.removeEventListener("abort", onAbort);
            resolve();
        };
        child.on("error", (err) => {
            process.stderr.write(`[talkback] player error: ${err.message}\n`);
            done();
        });
        child.on("exit", done);
        child.stdin?.end(input);
    });
}
class ElevenError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
// A "fatal" error means retrying ElevenLabs this session is pointless (out of
// characters, bad/missing key) — so we permanently drop to SAPI. Transient or
// voice-specific errors (rate limit, a tier-locked voice) only fall back for
// the one line and keep ElevenLabs active for the next.
function isFatalElevenError(err) {
    return (err instanceof ElevenError &&
        (err.code === "quota_exceeded" || err.code === "unauthorized" || err.code === "no_key"));
}
function fallbackNotice(err) {
    const code = err instanceof ElevenError ? err.code : "network";
    if (code === "quota_exceeded")
        return "Heads up — ElevenLabs is out of characters for now, so I'm switching to the local voice.";
    if (code === "no_key" || code === "unauthorized")
        return "The ElevenLabs key isn't working, so I'm switching to the local voice.";
    return "ElevenLabs hit a snag, switching to the local voice.";
}
async function fetchEleven(text, voiceId, signal) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key)
        throw new ElevenError("ELEVENLABS_API_KEY not set", "no_key");
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${ELEVEN_FORMAT}`;
    let res;
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
    }
    catch (err) {
        if (err?.name === "AbortError")
            throw err;
        throw new ElevenError(`network error: ${err.message}`, "network");
    }
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        let detailStatus = "";
        try {
            detailStatus = JSON.parse(body)?.detail?.status ?? "";
        }
        catch {
            /* body wasn't JSON */
        }
        const code = detailStatus === "quota_exceeded"
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
async function pump() {
    if (playing)
        return;
    playing = true;
    await ensureInitialized();
    while (queue.length > 0) {
        const item = queue.shift();
        const abort = new AbortController();
        currentAbort = abort;
        try {
            if (engine === "elevenlabs") {
                let audio = null;
                try {
                    audio = await fetchEleven(item.text, item.voice || elevenVoiceId, abort.signal);
                }
                catch (err) {
                    if (abort.signal.aborted)
                        continue;
                    const fatal = isFatalElevenError(err);
                    process.stderr.write(`[talkback] ElevenLabs failed (${err.message})` +
                        (fatal ? " — auto-switching to SAPI for the session\n" : "; SAPI for this line\n"));
                    if (fatal) {
                        engine = "sapi"; // stay on SAPI; stop retrying the exhausted/broken API
                        await runPlayer(sapiSpec(null), Buffer.from(fallbackNotice(err), "utf8"), abort);
                    }
                }
                if (abort.signal.aborted)
                    continue;
                if (audio) {
                    await runPlayer(mp3PlayerSpec(), audio, abort);
                }
                else {
                    await runPlayer(sapiSpec(null), Buffer.from(item.text, "utf8"), abort);
                }
            }
            else {
                await runPlayer(sapiSpec(item.voice ?? sapiVoice), Buffer.from(item.text, "utf8"), abort);
            }
        }
        catch (err) {
            if (!abort.signal.aborted) {
                process.stderr.write(`[talkback] playback error: ${err.message}\n`);
            }
        }
        finally {
            currentChild = null;
            currentAbort = null;
        }
    }
    playing = false;
}
/** Queue a line to be spoken. Returns immediately (non-blocking). */
export function speak(raw, opts = {}) {
    const text = tidyForSpeech(raw);
    if (!text)
        return { spoken: "", skipped: true };
    if (opts.interrupt)
        stopSpeaking();
    queue.push({ text, voice: opts.voice });
    void pump();
    return { spoken: text, skipped: false };
}
/** Cut off any in-progress speech and clear the queue. */
export function stopSpeaking() {
    queue.length = 0;
    currentAbort?.abort();
    if (currentChild) {
        try {
            currentChild.kill();
        }
        catch {
            /* already gone */
        }
        currentChild = null;
    }
}
// ---- engine + voice management ----------------------------------------------
export function getEngine() {
    return engine;
}
/** Switch engine at runtime. Returns false for an unknown engine name. */
export function setEngine(e) {
    if (e !== "sapi" && e !== "elevenlabs")
        return false;
    engine = e;
    return true;
}
function runCapture(cmd, args) {
    return new Promise((resolve, reject) => {
        let out = "";
        let err = "";
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    });
}
let elevenVoiceCache = null;
// The "sapi" engine is really "the OS's built-in, free TTS": PowerShell/SAPI on
// Windows, the `say` command on macOS, espeak on Linux. Enumerate whichever
// applies so voice selection + auto-pick work everywhere, not just Windows.
async function listSapiVoices() {
    if (PLATFORM === "wsl" || PLATFORM === "windows") {
        const ps = "Add-Type -AssemblyName System.Speech; " +
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
    if (PLATFORM === "macos") {
        // `say -v '?'` -> "Samantha           en_US    # Hello, my name is Samantha."
        const out = await runCapture("say", ["-v", "?"]);
        return out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
            const m = l.match(/^(.+?)\s{2,}([a-z]{2}[-_][A-Z]{2})/);
            return m ? { name: m[1].trim(), culture: m[2] } : { name: l.split(/\s{2,}/)[0] };
        })
            .filter((v) => v.name);
    }
    if (PLATFORM === "linux") {
        // `espeak --voices` -> columns; the 4th (index 3) is the voice name.
        const out = await runCapture("espeak", ["--voices"]);
        return out
            .split(/\r?\n/)
            .slice(1)
            .map((l) => l.trim().split(/\s+/))
            .filter((c) => c.length >= 4)
            .map((c) => ({ name: c[3], culture: c[1] }));
    }
    return [];
}
async function listElevenVoices() {
    if (!hasElevenKey())
        return [];
    if (elevenVoiceCache)
        return elevenVoiceCache;
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    const data = (await res.json());
    elevenVoiceCache = (data.voices || []).map((v) => ({
        name: v.name,
        id: v.voice_id,
        category: v.category,
        gender: v.labels?.gender,
    }));
    return elevenVoiceCache;
}
/** Enumerate voices for the active engine. */
export async function listVoices() {
    try {
        return engine === "elevenlabs" ? await listElevenVoices() : await listSapiVoices();
    }
    catch (err) {
        process.stderr.write(`[talkback] listVoices failed: ${err.message}\n`);
        return [];
    }
}
function matchVoice(voices, query) {
    const q = query.trim().toLowerCase();
    return (voices.find((v) => v.name.toLowerCase() === q || v.id?.toLowerCase() === q) ??
        voices.find((v) => v.name.toLowerCase().includes(q)) ??
        null);
}
/** Resolve a query to a concrete voice token for the active engine WITHOUT changing the default. */
export async function resolveVoice(query) {
    const match = matchVoice(await listVoices(), query);
    if (!match)
        return null;
    return engine === "elevenlabs" ? match.id ?? null : match.name;
}
function applyVoice(v) {
    if (engine === "elevenlabs") {
        if (!v.id)
            return;
        elevenVoiceId = v.id;
        saveRepoVoice("elevenlabs", v.id);
    }
    else {
        sapiVoice = v.name;
        saveRepoVoice("sapi", v.name);
    }
}
/**
 * Set the active voice for the current engine and remember it for this repo.
 * Accepts:
 *  - an exact name/id or partial name ("brian", "jessica")
 *  - a gender ("female" / "male") — picks a random voice of that gender
 *  - "random" / "any" / "surprise me" — picks any usable voice
 * Returns the chosen Voice (name + gender), or null if nothing matched.
 */
export async function setVoice(query) {
    const q = query.trim().toLowerCase();
    const voices = await listVoices();
    const pool = usablePool(voices);
    const wantGender = /\bfemale\b|\bwoman\b/.test(q)
        ? "female"
        : /\bmale\b|\bman\b/.test(q)
            ? "male"
            : null;
    const wantRandom = /\brandom\b|\bany\b|surprise/.test(q);
    let match = null;
    if (wantGender || wantRandom) {
        const filtered = wantGender
            ? pool.filter((v) => (v.gender ?? "").toLowerCase().startsWith(wantGender))
            : pool;
        match = pickRandom(filtered) ?? null;
    }
    if (!match)
        match = matchVoice(voices, query); // explicit name/id (may be non-premade)
    if (!match)
        return null;
    applyVoice(match);
    return match;
}
export function getActiveVoice() {
    return engine === "elevenlabs" ? elevenVoiceId : sapiVoice;
}
/** The currently active voice, with gender if known. */
export async function getActiveVoiceInfo() {
    const active = getActiveVoice();
    if (!active)
        return null;
    const voices = await listVoices();
    return voices.find((v) => v.id === active || v.name === active) ?? { name: active };
}
/**
 * The central registry: every repo that has picked a voice, with the voice
 * resolved to a display name. Lets you see what's assigned where and what's
 * already in use across projects.
 */
export async function getRepoRegistry() {
    const state = loadRepoState();
    const elevenById = new Map();
    const sapiByName = new Map();
    try {
        if (hasElevenKey())
            for (const v of await listElevenVoices())
                if (v.id)
                    elevenById.set(v.id, v);
    }
    catch {
        /* eleven list unavailable — fall back to raw ids */
    }
    try {
        for (const v of await listSapiVoices())
            sapiByName.set(v.name, v);
    }
    catch {
        /* sapi list unavailable */
    }
    const rows = [];
    for (const [key, token] of Object.entries(state)) {
        const sep = key.indexOf(":");
        const eng = key.slice(0, sep);
        const repo = key.slice(sep + 1);
        const resolved = eng === "elevenlabs" ? elevenById.get(token) : sapiByName.get(token);
        rows.push({
            repo,
            engine: eng,
            name: resolved?.name ?? token,
            gender: resolved?.gender,
            current: repo === REPO_ID && eng === engine,
        });
    }
    return rows.sort((a, b) => a.repo.localeCompare(b.repo));
}
export function backendInfo() {
    if (engine === "elevenlabs") {
        return `elevenlabs (voice=${elevenVoiceId}, model=${ELEVEN_MODEL}, key=${hasElevenKey() ? "set" : "MISSING"})`;
    }
    return `sapi (voice=${sapiVoice ?? "system default"}, rate=${RATE}) on ${PLATFORM}`;
}
function commandExists(cmd) {
    if (!cmd)
        return false;
    const probe = process.platform === "win32" ? "where" : "which";
    try {
        return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
    }
    catch {
        return false;
    }
}
function requiredBackend(forEngine) {
    if (PLATFORM === "wsl" || PLATFORM === "windows") {
        return {
            cmd: POWERSHELL,
            install: null,
            note: "PowerShell (built into Windows) drives both SAPI speech and ElevenLabs playback — no extra install.",
        };
    }
    if (PLATFORM === "macos") {
        return forEngine === "elevenlabs"
            ? {
                cmd: "ffplay",
                install: "brew install ffmpeg",
                note: "ElevenLabs MP3 playback uses ffplay (part of ffmpeg).",
            }
            : { cmd: "say", install: null, note: "Local speech uses the built-in macOS 'say' command." };
    }
    if (PLATFORM === "linux") {
        return forEngine === "elevenlabs"
            ? {
                cmd: "ffplay",
                install: "sudo apt install ffmpeg",
                note: "ElevenLabs MP3 playback uses ffplay (part of ffmpeg).",
            }
            : { cmd: "espeak", install: "sudo apt install espeak", note: "Local speech uses espeak." };
    }
    return { cmd: "", install: null, note: "Unrecognized platform — no audio backend available." };
}
const depCache = new Map();
/** Whether the audio backend the given engine needs is installed. Cached. */
export function checkDependencies(forEngine = engine) {
    const cached = depCache.get(forEngine);
    if (cached)
        return cached;
    const req = requiredBackend(forEngine);
    const found = req.cmd ? commandExists(req.cmd) : false;
    const status = {
        platform: PLATFORM,
        engine: forEngine,
        backend: req.cmd || "(none)",
        found,
        install: found ? null : req.install,
        note: req.note,
    };
    depCache.set(forEngine, status);
    return status;
}
/** A one-line warning if the active engine's audio backend is missing, else null. */
export function missingDependencyWarning(forEngine = engine) {
    const s = checkDependencies(forEngine);
    if (s.found)
        return null;
    const how = s.install ? ` Install it with: ${s.install}` : "";
    return `Audio backend "${s.backend}" wasn't found on this ${s.platform} system, so speech can't play.${how}`;
}
