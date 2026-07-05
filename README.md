# Crit

**Let your AI agent ask you for a design review — out loud, pointing at the real app.**

Crit is a new primitive for agentic product work:

> The agent asks for a Crit.
> You narrate a review while pointing around the app with your mouse.
> The agent receives a rich, timestamped review transcript with enough context to act.

When an agent runs `crit review`, your browser opens a mirrored copy of your app with a small
recording widget. You press Start, talk through your feedback while hovering, clicking, and
navigating like normal. When you press Stop, Crit transcribes your audio, condenses your
pointer/page activity into a readable timeline, merges the two with a small AI model, and hands
the agent a review like this:

```markdown
[00:03] On `/dashboard`, the user says the first impression feels cluttered.
        The pointer circles the main metrics cards.

[00:17] The user says, "I'm not sure what I'm supposed to click first."
        The pointer pauses near the "Create project" button but does not click it.

[00:31] The user clicks "Create project" (src/components/Hero.tsx, <Hero>) and
        lands on /projects/new.
```

Because Crit runs your app through the [ion compiler](ion-compiler-export/PROMPT.md), every
element you point at is annotated with its **source file, line, and React component** — so
"make this button stand out" arrives with the exact place in the code to do it.

## Quick start

```bash
git clone https://github.com/<you>/crit && cd crit
npm install
npm link        # puts `crit` on your PATH
npm test        # 27 tests, incl. a mock end-to-end run

# try it on any React app (Next.js or Vite), no API keys needed:
cd /path/to/your/app
crit review --mock-ai

# the real thing:
export OPENAI_API_KEY=...      # speech-to-text (whisper)
export ANTHROPIC_API_KEY=...   # transcript merge (optional; falls back to OpenAI)
crit review --source . --json
```

API keys resolve from the calling environment first (so an agent's shell env just works), then
from the reviewed project's `.env`/`.env.local` — only `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
and `CRIT_*` are read from there; the rest of the project's secrets are never touched.

The CLI blocks until you finish (or cancel) the review in the browser, then prints the final
transcript — plain Markdown by default, or a single machine-readable JSON object with `--json`.

## For agents

Give your agent a tool/slash command that runs:

```bash
crit review --source . --json
```

A ready-made Claude Code command lives at [.claude/commands/crit.md](.claude/commands/crit.md)
(`/crit`). Copy it to `~/.claude/commands/` to use it in every project. The JSON result contains
`final_transcript` (Markdown), plus paths to structured artifacts (`review.json` has the issue
list and timeline with timestamps, URLs, and source anchors).

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
are in **[docs/crit.md](docs/crit.md)**. The compiler/mirroring system that powers the source
annotations is documented in **[ion-compiler-export/PROMPT.md](ion-compiler-export/PROMPT.md)**.

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
collector over HTTP exactly like the browser widget does.

## License

[MIT](LICENSE)
