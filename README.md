# Crit

**Let your AI agent ask you for a design review — out loud, pointing at the real app.**

The agent runs `crit review`. Your browser opens a mirrored copy of your app with a recording
widget. You narrate feedback while pointing, clicking, and navigating. The agent gets back a
timestamped transcript where every "this" and "here" is resolved to a real element — with its
source file, line, and React component.

## How to

### 1. Install the CLI

```bash
git clone https://github.com/ion-design/design-crit.git
cd design-crit
npm install
npm link        # puts `crit` on your PATH
```

Requires Node 20+. Verify with:

```bash
crit --help
```

### 2. Set API keys

Crit needs a speech-to-text key, and optionally an Anthropic key for the transcript merge:

```bash
export OPENAI_API_KEY=sk-...      # required: Whisper transcription
export ANTHROPIC_API_KEY=sk-...   # optional: Claude does the merge (falls back to OpenAI)
```

You can also just put these in the reviewed project's `.env` — crit reads `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, and `CRIT_*` from there (calling env wins; no other project secrets are
touched). No keys at all? Use `--mock-ai` to try the full loop with canned transcription.

### 3. Run a review

```bash
cd /path/to/your/react-app     # Next.js or Vite (any app with a dev server works)
crit review
```

Your browser opens the mirrored app. Press **● Start Crit**, allow the microphone, and talk
through your feedback while using your mouse as a pointer — a panel at the bottom-left shows
the source file of whatever you're hovering. Press **■ Stop** when done. The final review
prints to stdout and artifacts land in `.crit/reviews/<session>/`.

### 4. Install it into your agent

**Claude Code** — copy the ready-made slash command, then type `/crit` in any project:

```bash
cp .claude/commands/crit.md ~/.claude/commands/crit.md
```

**Any other agent** — register a tool/command that shells out to:

```bash
crit review --source . --json
```

The call blocks until the user finishes (give it a generous timeout — reviews take minutes).
stdout is a single JSON object: on `"status": "completed"`, read `final_transcript` (Markdown)
and `artifacts.review_json` (structured issues/timeline with timestamps, URLs, and source
anchors). `"cancelled"` means the user declined; `"error"` carries `error.code` and any partial
artifact paths.

## What the agent gets back

```markdown
[00:03] On `/dashboard`, the user says the first impression feels cluttered.
        The pointer circles the main metrics cards.

[00:15] The user says "these two buttons should just be links" while pointing
        at the "Dashboard" and "Projects" buttons (src/App.jsx:12–13, <App>).
```

Plus structured issues and follow-ups an agent can act on directly, and a verbatim
speech-plus-pointer transcript with no AI rewriting as ground truth. Because Crit runs your
app through the [ion compiler](ion-compiler-export/PROMPT.md), every element you point at is
annotated with its exact source location.

## How it works

```
crit review
 ├─ mirror the app into a temp dir (original source is never touched)
 │    · Babel pass stamps data-ion-* source annotations on every JSX element
 │    · recording widget script injected (JSX <body> or index.html)
 │    · node_modules: APFS clone on macOS, symlink elsewhere, or --install
 ├─ start a localhost-only collector server
 ├─ start the app's own dev server from the mirror (next / vite / npm run dev)
 ├─ open the browser → user records a narrated review
 │    · mic audio (MediaRecorder, 1s chunks)
 │    · mouse moves (throttled), clicks, scrolls, page/URL changes
 │    · element context: tag, role, text, aria-label + source file/line/component
 ├─ on Stop: speech-to-text → condense interaction log → AI merge
 └─ write artifacts to .crit/reviews/<session>/, print result, clean up
```

Full details — CLI flags, env vars, artifact formats, error codes, privacy model, limitations —
are in **[docs/crit.md](docs/crit.md)**.

## Privacy

Crit is local-first: the collector binds to `127.0.0.1`, sessions use unguessable ids, and
nothing leaves your machine except the audio sent to your configured STT provider and the two
text transcripts sent to your configured merge model. No screen video. Input **values** are
never recorded (password fields yield only their type), and no cookies, storage, or headers are
captured. Recording only starts when you press Start, with a pulsing red indicator while live.

## Repo layout

| Path | What |
| --- | --- |
| `bin/crit.js`, `src/` | CLI: orchestrator, mirror, app runner, collector, condensation, providers |
| `overlay/crit-overlay.js` | The in-browser recording widget + event capture |
| `ion-compiler-export/` | Babel plugin + shadow-directory processor (source annotations) |
| `test/` | Unit tests + `--mock-ai` end-to-end tests against a fixture app |
| `docs/crit.md` | Full documentation |

## Development

```bash
npm test                                  # full suite (no keys, no mic needed)
crit review --source test/fixtures/demo-app --mock-ai --no-open --json
```

Mock providers (`--mock-ai`) make the whole loop runnable headlessly; the e2e tests drive the
collector over HTTP exactly like the browser widget does. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
