# claude-talkback-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Gives Claude Code a **voice**. It speaks short, conversational, peer-style summaries of what
it's doing out your speakers — while the full detail still scrolls in the terminal as usual.
Dual output: the screen has the transcript, the voice has the gist.

- **Two engines, toggle live:**
  - `sapi` — built-in Windows voice. Offline, free, zero setup, but robotic.
  - `elevenlabs` — natural cloud voice. Bring your own API key.
- **Works from WSL and native Windows** — from WSL it reaches the Windows audio stack via
  `powershell.exe` (SAPI speaks directly; ElevenLabs MP3 plays through Windows MediaPlayer), so
  there's no audio-passthrough setup.
- **Pick any voice** — `list_voices` / `set_voice`, an env default, or a per-line override.
- **Non-blocking & interruptible** — speaking never stalls Claude; a new line can cut off the
  current one (barge-in) so it pivots to you mid-sentence.
- **Graceful fallback** — if an ElevenLabs call fails (quota, tier-locked voice, network), it
  automatically falls back to SAPI so you're never left in silence.

## Demo

Hear the difference — click to listen/download (GitHub doesn't autoplay audio inline):

- ▶️ **Natural voice (ElevenLabs):** [`assets/demo-elevenlabs.mp3`](assets/demo-elevenlabs.mp3)
- ▶️ **Free built-in voice (Windows SAPI):** [`assets/demo-sapi.wav`](assets/demo-sapi.wav)

<sub>ElevenLabs sample generated with <a href="https://elevenlabs.io">ElevenLabs</a>.</sub>

## Tools

| Tool | What it does |
|------|--------------|
| `speak` | Speak one or two short sentences. `interrupt:true` cuts off current speech; `voice` overrides for that line. |
| `stop_speaking` | Immediately silence and clear the queue. |
| `list_voices` | List every voice available for the **active engine** (★ = active). |
| `set_voice` | Set + remember the voice for this repo. Takes a name/id, a partial (`"jessica"`), a **gender** (`"female"`/`"male"` → random of that gender), or `"random"`. |
| `set_engine` | Toggle between `sapi` and `elevenlabs` at runtime. |
| `voice_status` | Report the active engine + current voice, including whether it's male or female. |
| `list_repo_voices` | Show the central registry — which voice each repo/project has been assigned. |

## Build

```bash
npm install
npm run build
```

## Register with Claude Code

Point Claude Code at the compiled entry point. `--scope user` makes it available in every
project (use `--scope project` to scope to one repo). The **same command works on native
Windows/PowerShell** — the server auto-detects the environment.

**SAPI only (free, offline):**

```bash
claude mcp add talkback --scope user \
  -- node /home/cory/personal/claude-talkback-mcp/dist/index.js
```

**With ElevenLabs (natural voice):**

```bash
claude mcp add talkback --scope user \
  --env ELEVENLABS_API_KEY="<your-elevenlabs-key>" \
  --env TALKBACK_ENGINE="elevenlabs" \
  -- node /home/cory/personal/claude-talkback-mcp/dist/index.js
```

> Claude Code loads MCP servers at startup — after `mcp add` / changing env, **restart Claude
> Code** (or `/mcp` → reconnect) for changes to take effect. Confirm with `/mcp`.

## Configuration (env vars)

**General**

| Var | Default | Meaning |
|-----|---------|---------|
| `TALKBACK_ENGINE` | `elevenlabs` if a key is set, else `sapi` | Which engine to start on. |
| `TALKBACK_MAX_CHARS` | `600` | Hard cap on spoken length — safety net so nothing long is read aloud. |

**SAPI**

| Var | Default | Meaning |
|-----|---------|---------|
| `TALKBACK_VOICE` | system default | SAPI voice name (e.g. `Microsoft Zira Desktop`). |
| `TALKBACK_RATE` | `1` | Speech speed, SAPI scale `-10`..`10`. |

**ElevenLabs**

| Var | Default | Meaning |
|-----|---------|---------|
| `ELEVENLABS_API_KEY` | — | Your key (required for the `elevenlabs` engine). |
| `ELEVENLABS_VOICE_ID` | Jessica (`cgSgspJ2msm6clMCkdW9`) | Default voice id. |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | TTS model. |
| `ELEVENLABS_FORMAT` | `mp3_44100_128` | Output format (PCM needs a paid tier). |
| `ELEVENLABS_SPEED` | `0.9` | Pacing, `0.7`–`1.2`. `<1` = slower/less rushed. |
| `ELEVENLABS_STABILITY` | `0.5` | `0`–`1`. Higher = more consistent delivery. |
| `ELEVENLABS_SIMILARITY` | `0.75` | `0`–`1`. Similarity boost. |

### A note on free-tier ElevenLabs

On a **free** ElevenLabs plan, only the ~21 **premade** voices work through the API. "Professional"
/ Voice-Library voices you've added (e.g. **Ava**) return `402 paid_plan_required` via the API even
though they work in the ElevenLabs app — using them here needs a paid plan (Starter and up). When
that happens the server logs it and falls back to SAPI for that line. Once you upgrade,
`set_voice ava` works with no code changes.

## Per-repo voices (a different voice per project)

Every repo automatically gets its **own** voice, so when you have multiple Claude Code windows
open you can tell them apart by ear — like different teammates.

- **Auto-assigned on first load.** The first time the server starts in a repo, it picks a voice at
  random and remembers it — preferring one **no other repo is already using**, so projects stay
  distinct until you run out of voices.
- **Persistent.** Choices are saved to `~/.claude-talkback/repos.json`, keyed by repo path, so a
  repo keeps its voice across restarts. (Override the location with `TALKBACK_STATE_DIR`.)
- **Change it anytime.** Ask Claude to switch — `set_voice` takes a name (`"brian"`), a gender
  (`"female"` / `"male"` → a random voice of that gender), or `"random"`, and saves the new pick
  for that repo. `voice_status` says which voice/gender is active right now.
- **See the whole map.** `list_repo_voices` prints the central registry (the `→` marks the current
  repo):

  ```
  Voices by repo:
    /work/repoA  —  Callum - Husky Trickster, male [elevenlabs]
  → /work/repoB  —  Alice - Clear, Engaging Educator, female [elevenlabs]
    /work/repoC  —  Liam - Energetic, Social Media Creator, male [elevenlabs]
  ```

Auto-pick only draws from **free-tier premade** ElevenLabs voices, so it never lands on a
tier-locked one. To pin a repo to a specific voice, set `ELEVENLABS_VOICE_ID` in that repo's
registration — an explicit pin always wins and is never overwritten.

## How the conversational behavior works

The server ships **instructions** (surfaced to Claude Code on connect) telling Claude to:

1. End each top-level response with a short spoken summary — never read code, logs, or long
   lists aloud, just the gist.
2. **Don't go silent during long multi-step work** — speak a one-line update at each *milestone*
   (not every tool call), so you hear progress as it happens instead of only at the end.
3. Give a spoken heads-up before slow work, then **run it in the background** so its turn ends
   and you can keep chatting — then speak the result when it finishes.
4. Keep turns short so you can interrupt between them; use `interrupt:true` to pivot when you talk.
5. Talk like a collaborator — warm, first person, no filler.

> **Note on "talk to it while it works":** Claude Code is turn-based — while it's blocked on a
> single foreground operation it isn't running, so there's no true simultaneous chat *within*
> one call. The conversational feel comes from Claude **backgrounding** slow work so turns stay
> short and control returns to you frequently. That behavior lives in the instructions above.

## License

[MIT](LICENSE) © Cory Loriot
