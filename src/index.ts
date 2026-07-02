#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  speak,
  stopSpeaking,
  listVoices,
  setVoice,
  resolveVoice,
  getActiveVoice,
  getEngine,
  setEngine,
  backendInfo,
} from "./tts.js";

const INSTRUCTIONS = `This server gives you a VOICE. The \`speak\` tool reads short text aloud through the user's speakers. Treat it like talking to a peer sitting next to you.

HOW TO USE IT:
1. End each top-level response with a \`speak\` call: ONE or TWO short, conversational sentences that capture the gist of what you did or found. The screen already has the full detail — the voice is the summary. NEVER speak code, logs, file contents, stack traces, or long lists; describe them in a sentence instead ("tests pass", "found three usages", "pushed to main").
2. DON'T GO SILENT during longer multi-step work (tracing code, multi-file edits, investigations). Speak a short one-line update at each MILESTONE as you go — e.g. "commits are clean… now checking the encryption path… round-trip matches." Narrate at milestones, NOT on every tool call: per-tool narration makes the voice lag behind the work and gets spammy; milestone-level keeps you present and in sync. If you're about to do several tool calls in a row without talking, that's the cue to speak first.
3. Before starting slow work, \`speak\` a quick heads-up ("kicking off the build, I'll keep talking while it runs"), then PREFER running that work in the BACKGROUND so your turn ends and the user can keep chatting. When it finishes, \`speak\` a short result.
4. Keep turns short so the user can interrupt between them. If the user talks while you're narrating, pass interrupt:true on your next \`speak\` so the current line is cut off and you respond to them.
5. Tone: warm, direct, first person, contractions. A collaborator, not a narrator. No preamble, no filler.

Voices: \`list_voices\` / \`set_voice\`. Engine: \`set_engine\` toggles between "sapi" (robotic, offline, free) and "elevenlabs" (natural, needs the user's API key).`;

const server = new McpServer(
  { name: "claude-talkback", version: "0.2.0" },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  "speak",
  {
    title: "Speak aloud (conversational)",
    description:
      "Speak a short, conversational line to the user through their speakers. Pass ONE or TWO plain sentences — the gist, never full output/code/logs. Call this at the end of each top-level response. Set interrupt:true to cut off whatever is currently being spoken and say this instead (barge-in). Optionally set voice to override the active voice for this line only.",
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
  },
  async ({ text, interrupt, voice }) => {
    const resolved = voice ? ((await resolveVoice(voice)) ?? undefined) : undefined;
    const r = speak(text, { interrupt: interrupt ?? false, voice: resolved });
    return {
      content: [{ type: "text", text: r.skipped ? "(nothing to speak)" : `🔊 ${r.spoken}` }],
    };
  },
);

server.registerTool(
  "stop_speaking",
  {
    title: "Stop speaking",
    description: "Immediately stop any in-progress speech and clear the queue.",
    inputSchema: {},
  },
  async () => {
    stopSpeaking();
    return { content: [{ type: "text", text: "🔇 stopped" }] };
  },
);

server.registerTool(
  "list_voices",
  {
    title: "List available voices",
    description:
      "List every text-to-speech voice available for the ACTIVE engine, so the user can pick one. The ★ marks the currently active voice.",
    inputSchema: {},
  },
  async () => {
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
  },
);

server.registerTool(
  "set_voice",
  {
    title: "Set the active voice",
    description:
      "Set the voice for the active engine. Accepts an exact name/id or a partial match (e.g. 'brian' or 'zira'). Use list_voices to see options.",
    inputSchema: {
      name: z.string().describe("Voice name, exact or partial (case-insensitive)."),
    },
  },
  async ({ name }) => {
    const resolved = await setVoice(name);
    return {
      content: [
        {
          type: "text",
          text: resolved
            ? `✅ Voice set to "${resolved}".`
            : `No voice matched "${name}" for the ${getEngine()} engine. Try list_voices.`,
        },
      ],
    };
  },
);

server.registerTool(
  "set_engine",
  {
    title: "Switch speech engine",
    description:
      "Toggle the speech engine. 'sapi' = built-in Windows voice (robotic, offline, free). 'elevenlabs' = natural cloud voice (needs the user's ELEVENLABS_API_KEY in the server env).",
    inputSchema: {
      engine: z.enum(["sapi", "elevenlabs"]).describe("Which engine to use."),
    },
  },
  async ({ engine }) => {
    setEngine(engine);
    return { content: [{ type: "text", text: `🔀 Engine set to "${engine}". ${backendInfo()}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[talkback] ready — backend: ${backendInfo()}\n`);
