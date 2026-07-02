#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { speak, stopSpeaking, listVoices, setVoice, resolveVoice, getActiveVoice, getActiveVoiceInfo, getRepoRegistry, getEngine, setEngine, ensureInitialized, checkDependencies, missingDependencyWarning, backendInfo, } from "./tts.js";
const INSTRUCTIONS = `This server gives you a VOICE. The \`speak\` tool reads short text aloud through the user's speakers. Treat it like talking to a peer sitting next to you.

HOW TO USE IT:
1. End each top-level response with a \`speak\` call: ONE or TWO short, conversational sentences that capture the gist of what you did or found. The screen already has the full detail — the voice is the summary. NEVER speak code, logs, file contents, stack traces, or long lists; describe them in a sentence instead ("tests pass", "found three usages", "pushed to main").
2. DON'T GO SILENT during longer multi-step work (tracing code, multi-file edits, investigations). Speak a short one-line update at each MILESTONE as you go — e.g. "commits are clean… now checking the encryption path… round-trip matches." Narrate at milestones, NOT on every tool call: per-tool narration makes the voice lag behind the work and gets spammy; milestone-level keeps you present and in sync. If you're about to do several tool calls in a row without talking, that's the cue to speak first.
3. Before starting slow work, \`speak\` a quick heads-up ("kicking off the build, I'll keep talking while it runs"), then PREFER running that work in the BACKGROUND so your turn ends and the user can keep chatting. When it finishes, \`speak\` a short result.
4. Keep turns short so the user can interrupt between them. If the user talks while you're narrating, pass interrupt:true on your next \`speak\` so the current line is cut off and you respond to them.
5. Tone: warm, direct, first person, contractions. A collaborator, not a narrator. No preamble, no filler.

Voices: each repo auto-picks its own voice on first load and remembers it, so different projects sound like different teammates. If the user asks who's talking, use \`voice_status\` to report the current voice and whether it's male/female. To change it, use \`set_voice\` — it takes a name ("brian"), a gender ("female"/"male", picks one of that gender), or "random", and saves the choice for this repo. \`list_voices\` shows the options; \`list_repo_voices\` shows which voice every repo has been assigned; \`set_engine\` toggles "sapi" (the OS's built-in free voice — SAPI on Windows, say on macOS, espeak on Linux) vs "elevenlabs" (natural, needs the user's API key). If the user says they can't hear anything, call \`check_setup\` — it reports whether a required audio tool is missing and exactly how to install it.`;
const server = new McpServer({ name: "claude-talkback", version: "0.3.0" }, { instructions: INSTRUCTIONS });
server.registerTool("speak", {
    title: "Speak aloud (conversational)",
    description: "Speak a short, conversational line to the user through their speakers. Pass ONE or TWO plain sentences — the gist, never full output/code/logs. Call this at the end of each top-level response. Set interrupt:true to cut off whatever is currently being spoken and say this instead (barge-in). Optionally set voice to override the active voice for this line only.",
    inputSchema: {
        text: z
            .string()
            .describe("One or two short, conversational sentences. The gist, not the transcript."),
        interrupt: z
            .boolean()
            .optional()
            .describe("If true, stop whatever is currently being spoken and say this immediately."),
        voice: z
            .string()
            .optional()
            .describe("Optional voice name (exact or partial) to use for this line only."),
    },
}, async ({ text, interrupt, voice }) => {
    const resolved = voice ? ((await resolveVoice(voice)) ?? undefined) : undefined;
    const r = speak(text, { interrupt: interrupt ?? false, voice: resolved });
    const base = r.skipped ? "(nothing to speak)" : `🔊 ${r.spoken}`;
    const warn = missingDependencyWarning();
    return {
        content: [
            { type: "text", text: warn ? `${base}\n\n⚠️ ${warn} (run check_setup for details)` : base },
        ],
    };
});
server.registerTool("stop_speaking", {
    title: "Stop speaking",
    description: "Immediately stop any in-progress speech and clear the queue.",
    inputSchema: {},
}, async () => {
    stopSpeaking();
    return { content: [{ type: "text", text: "🔇 stopped" }] };
});
server.registerTool("list_voices", {
    title: "List available voices",
    description: "List every text-to-speech voice available for the ACTIVE engine, so the user can pick one. The ★ marks the currently active voice.",
    inputSchema: {},
}, async () => {
    const voices = await listVoices();
    const active = getActiveVoice();
    const header = `Engine: ${getEngine()}`;
    if (voices.length === 0) {
        return { content: [{ type: "text", text: `${header}\nNo voices found.` }] };
    }
    const lines = voices.map((v) => {
        const star = active && (v.name === active || v.id === active) ? "★ " : "  ";
        const meta = [v.culture, v.gender].filter(Boolean).join(", ");
        return `${star}${v.name}${meta ? ` (${meta})` : ""}`;
    });
    return { content: [{ type: "text", text: `${header}\nAvailable voices:\n${lines.join("\n")}` }] };
});
server.registerTool("set_voice", {
    title: "Set the active voice",
    description: "Set the voice for the active engine and remember it for this repo. Accepts an exact name/id, a partial name ('brian', 'jessica'), a gender ('female' or 'male' → picks a random voice of that gender), or 'random'. Use list_voices to see options.",
    inputSchema: {
        name: z
            .string()
            .describe("A voice name/id, a partial name, a gender ('female'/'male'), or 'random'."),
    },
}, async ({ name }) => {
    const v = await setVoice(name);
    if (!v) {
        return {
            content: [
                {
                    type: "text",
                    text: `No voice matched "${name}" for the ${getEngine()} engine. Try list_voices.`,
                },
            ],
        };
    }
    const g = v.gender ? ` (${v.gender})` : "";
    return {
        content: [{ type: "text", text: `✅ Voice set to "${v.name}"${g} — saved for this repo.` }],
    };
});
server.registerTool("voice_status", {
    title: "Current voice & engine",
    description: "Report the active engine and current voice, including whether it's male or female (when known). Use to answer 'which voice are you using?' or 'am I male or female right now?'.",
    inputSchema: {},
}, async () => {
    const v = await getActiveVoiceInfo();
    const name = v?.name ?? "unknown";
    const gender = v?.gender ? `, ${v.gender}` : "";
    return { content: [{ type: "text", text: `Engine: ${getEngine()} — voice: ${name}${gender}` }] };
});
server.registerTool("list_repo_voices", {
    title: "Voices assigned across repos",
    description: "Show the central registry of which voice each repo/project has been assigned (the → marks this repo). Useful for seeing what's already in use so voices stay distinct across projects.",
    inputSchema: {},
}, async () => {
    const rows = await getRepoRegistry();
    if (rows.length === 0) {
        return { content: [{ type: "text", text: "No repos have picked a voice yet." }] };
    }
    const lines = rows.map((r) => {
        const mark = r.current ? "→ " : "  ";
        const gender = r.gender ? `, ${r.gender}` : "";
        return `${mark}${r.repo}  —  ${r.name}${gender} [${r.engine}]`;
    });
    return { content: [{ type: "text", text: `Voices by repo:\n${lines.join("\n")}` }] };
});
server.registerTool("check_setup", {
    title: "Check audio setup / dependencies",
    description: "Report the platform, active engine, Node version, and whether the required audio backend (and ElevenLabs key) are installed — with install instructions for anything missing. Use this if the user says they can't hear anything.",
    inputSchema: {},
}, async () => {
    const s = checkDependencies();
    const lines = [
        `Platform:      ${s.platform}`,
        `Engine:        ${getEngine()}`,
        `Node:          ${process.version}`,
        `Audio backend: ${s.backend} — ${s.found ? "found ✅" : "MISSING ❌"}`,
        s.note,
    ];
    if (getEngine() === "elevenlabs") {
        lines.push(`ElevenLabs key: ${process.env.ELEVENLABS_API_KEY ? "set ✅" : "MISSING ❌ — set ELEVENLABS_API_KEY"}`);
    }
    if (!s.found && s.install)
        lines.push("", `To fix: ${s.install}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.registerTool("set_engine", {
    title: "Switch speech engine",
    description: "Toggle the speech engine. 'sapi' = your OS's built-in, free, offline voice (Windows SAPI, macOS 'say', or Linux espeak). 'elevenlabs' = natural cloud voice (needs the user's ELEVENLABS_API_KEY in the server env).",
    inputSchema: {
        engine: z.enum(["sapi", "elevenlabs"]).describe("Which engine to use."),
    },
}, async ({ engine }) => {
    setEngine(engine);
    return { content: [{ type: "text", text: `🔀 Engine set to "${engine}". ${backendInfo()}` }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
await ensureInitialized(); // pick/restore this repo's voice before the first line
const depWarn = missingDependencyWarning();
if (depWarn)
    process.stderr.write(`[talkback] ⚠️ ${depWarn}\n`);
process.stderr.write(`[talkback] ready — backend: ${backendInfo()}\n`);
