# Crit

Crit lets an AI agent request a narrated app review from a human. It mirrors the app into a
temporary directory (via the ion compiler pipeline, which annotates every JSX element with its
source file/line/component), injects a movable recording widget, collects microphone audio and
interaction context, then returns a merged, timestamped review transcript the agent can act on.

> The agent asks for a Crit.
> The user narrates a review while pointing around the app.
> The agent receives a rich, timestamped review transcript with enough context to act.

## How it works

```
crit review --source . --json
   │
   ├─ 1. mirror the app into a temp dir (BabelProcessor from ion-compiler-export)
   │      · every JSX element gets data-ion-* source annotations
   │      · <script src="/crit-overlay.js"> is injected (babel plugin for JSX <body>,
   │        index.html post-processing for Vite-style apps)
   │      · node_modules: APFS clone on macOS, symlink elsewhere, or --install
   ├─ 2. start a localhost collector server (events + audio uploads)
   ├─ 3. start the app's dev server from the mirror (next / vite / npm run dev)
   ├─ 4. open the browser
   ├─ 5. user records: audio + mouse/click/scroll/page events stream to the collector
   ├─ 6. on Stop: transcribe audio (STT provider), condense the interaction log,
   │      merge both with a small AI model
   └─ 7. write artifacts, print the final transcript to stdout, clean up
```

The CLI blocks until the user completes or cancels the review. The original source app is never
modified.

## Running

```bash
# from the app you want reviewed
node /path/to/design-crit/bin/crit.js review --source . --json

# or, after `npm link` inside design-crit:
crit review --source . --json

# local testing without any API keys or microphone
crit review --source . --mock-ai --no-open
```

## CLI options

```
--source <path>          Source project directory. Default: current working directory.
--out <path>             Directory for final review artifacts. Default: <source>/.crit/reviews.
--temp-dir <path>        Optional explicit temp dir. Default: OS temp dir.
--port <number>          Preferred local app port. Auto-picked if unavailable.
--no-open                Do not automatically open the browser.
--json                   Print machine-readable JSON to stdout (and nothing else).
--keep-temp              Do not delete the temp mirror after completion.
--install                Real dependency install in the mirror instead of clone/symlink
                         (use if the dev server rejects linked node_modules).
--stt-provider <name>    Speech-to-text provider: openai | mock.
--stt-model <name>       Speech-to-text model (default: whisper-1).
--merge-provider <name>  Transcript merge provider: anthropic | openai | mock.
--merge-model <name>     Merge model (default: claude-haiku-4-5 / gpt-4.1-mini).
--mock-ai                Use mock transcription + merge for local testing.
```

## Environment variables and API keys

```
OPENAI_API_KEY           Required for the default STT provider (whisper).
ANTHROPIC_API_KEY        Used for transcript merge when present (preferred).
CRIT_STT_PROVIDER        Default for --stt-provider.
CRIT_STT_MODEL           Default for --stt-model.
CRIT_MERGE_PROVIDER      Default for --merge-provider.
CRIT_MERGE_MODEL         Default for --merge-model.
```

Keys are resolved in this order (first match wins):

1. **The calling process environment.** `crit` inherits the env of whoever spawns it — so if
   the agent (e.g. Claude Code) runs in a shell where `OPENAI_API_KEY` is exported, crit uses
   that key automatically. Nothing to configure.
2. **The reviewed project's `.env` / `.env.local`** (in `--source`). Only the whitelisted keys
   above are read — crit never imports the project's other secrets (`DATABASE_URL` etc. are
   ignored), and values are never logged. `.env.local` overrides `.env`.

So all of these work:

```bash
export OPENAI_API_KEY=sk-...     # once per shell — inherited by every crit run
OPENAI_API_KEY=sk-... crit review          # per-invocation
echo 'OPENAI_API_KEY=sk-...' >> .env       # per-project (already there for most apps)
```

Provider selection: STT defaults to `openai`; merge defaults to `anthropic` if
`ANTHROPIC_API_KEY` is set (after the resolution above), otherwise `openai`. Explicit
`--stt-provider`/`--merge-provider` flags always win, and `--mock-ai` overrides everything.

## Completing a Crit (the user's side)

1. The browser opens on a mirrored copy of the app with a dark pill-shaped widget at the
   bottom of the page (draggable).
2. Press **● Start Crit** and grant microphone permission.
3. Talk through your feedback while using the mouse as a pointer — hover, click, scroll,
   and navigate normally. Everything is timestamped.
4. Press **■ Stop** when done (or **↻ Restart** to discard and start over, **✕** to cancel).
5. The widget shows "Processing…" then "Review sent back to the agent."

If microphone permission is denied you can retry or record without audio (interaction
context only).

## Agent output

With `--json`, stdout is a single JSON object:

```json
{
  "status": "completed",
  "session_id": "crit_2026_07_04_abc123",
  "started_at": "2026-07-04T18:22:10.000Z",
  "completed_at": "2026-07-04T18:27:45.000Z",
  "duration_ms": 335000,
  "final_transcript": "# Crit Review\n\n...",
  "artifacts": { "review_markdown": ".crit/reviews/.../review.md", "...": "..." }
}
```

Cancelled sessions return `{"status": "cancelled", "reason": "user_cancelled"}`; errors return
`{"status": "error", "error": {"code", "message"}, "artifacts": {...partial...}}`.

Error codes: `MIRROR_FAILED`, `TEMP_DIR_FAILED`, `INSTALL_FAILED`, `APP_START_FAILED`,
`STT_FAILED`, `MERGE_FAILED`, `PROCESSING_FAILED`, `INTERNAL_ERROR`.

## Artifacts

Written to `.crit/reviews/<session_id>/`:

| File | Contents |
| --- | --- |
| `review.md` | Final merged Crit transcript (Markdown) |
| `review.json` | Structured review: summary, timeline, issues, suggested follow-ups |
| `audio.webm` | Raw microphone recording |
| `speech_transcript.json` | Timestamped STT output |
| `interaction_log.jsonl` | Every raw browser event, one JSON object per line |
| `interaction_timeline.json` | Condensed human-readable interaction timeline |
| `merged_timeline.json` | Timeline section of the merged review |
| `session.json` | Session metadata (dirs, url, providers, timing) |

If STT succeeds but the merge fails, the speech transcript and interaction timeline are still
written and the error JSON lists their paths.

## Privacy

- Local-first: the collector binds to 127.0.0.1 and rejects unknown session ids.
- No screen video. Only microphone audio, pointer/click/scroll events, page changes, and
  limited element metadata (tag, role, aria-label, placeholder, short visible text, id/class,
  href path, and the ion source annotation).
- Password inputs contribute nothing but `input_type: "password"`. Input **values** are never
  recorded. No cookies, storage, or request headers are captured.
- Recording starts only when the user clicks Start; a pulsing red dot shows while recording.

## Agent integration

`crit install` (or `npx design-crit install`) detects your AI coding harnesses and installs
the Crit skill into each:

| Harness | Target |
| --- | --- |
| Claude Code | `~/.claude/skills/crit/SKILL.md` (global) or `./.claude/skills/crit/` (project) |
| Cursor | `./.cursor/rules/crit.mdc` |
| GitHub Copilot | `./.github/skills/crit/SKILL.md` |
| Codex CLI | `~/.agents/skills/crit/SKILL.md` (global) or `./.agents/skills/crit/` (project) |

Flags: `--providers claude,cursor,copilot,codex`, `--scope auto|global|project`, `--dry-run`.
Auto mode only touches harnesses whose folders already exist; explicitly named providers get
their folders created. The canonical skill text is [../skill/SKILL.md](../skill/SKILL.md) — it
teaches the agent to install the CLI on first use, check keys, run the review, and act on the
result. A plain `/crit` slash command also ships at `.claude/commands/crit.md` for repos that
prefer commands over skills.

## Relationship to the ion compiler

Crit reuses the ion compiler export (`ion-compiler-export/`) unchanged in behavior:

- `babel-processor.js` clones + transforms the app into the mirror (now accepts
  `pluginOptions`/`extraIgnorePatterns`).
- `ion-babel-plugin.js` stamps `data-ion-*` attributes and injects script tags into JSX
  `<body>` elements (now accepts an `injectScripts` option; default behavior unchanged).
- `ion-injection.js` is served in the mirror at `/ion-injection.js` (window.__ion snapshot
  tooling), and the Crit overlay decodes `data-ion-id` to attach `source.file/line/component`
  to event targets.

## Known limitations

- A full page reload during recording drops the microphone stream; event capture resumes
  (same clock via sessionStorage) but the rest of the review is audio-less. SPA navigation
  (Next.js app router, Vite SPAs) is unaffected.
- Next.js + Turbopack rejects symlinked node_modules; macOS uses an APFS clone which works.
  On other platforms use `--install` for Next apps.
- Elements rendered outside JSX (portals to hand-built DOM, `dangerouslySetInnerHTML`) carry
  no source annotations; events on them still record tag/text metadata.
- The condensed timeline mentions targets best-effort; repeated `.map()` renders share the
  same annotation.
