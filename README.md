<p align="center">
  <img src="docs/assets/crit-wave.png" alt="Crit, a doodled speech-bubble character with ^ ^ eyes, waving hello" width="220">
</p>

# design-crit

**Give your AI agent a design review it can see: you talk and point at the real app, the agent gets a timestamped transcript with the source file of everything you pointed at.**

The agent runs `crit review`. Your browser opens a mirrored copy of your app with a recording
widget. You narrate feedback while pointing, clicking, and navigating. The agent gets back a
transcript where every "this" and "here" is resolved to a real element, with its source file,
line, and React component.

## Install

```bash
npx design-crit install
```

This detects your AI coding agents (Claude Code, Cursor, GitHub Copilot, Codex CLI) and
installs the Crit skill into each. Requires Node 20+. The skill teaches your agent to fetch
the `crit` CLI itself the first time it needs it. To update later, rerun the same command.

```bash
npx design-crit install --providers claude,cursor --scope project
npx design-crit install --dry-run          # see what it would do
```

## Set API keys

One OpenAI key covers everything: Whisper for transcription, `gpt-5.6-luna` for the merge.

```bash
export OPENAI_API_KEY=sk-...      # required
export ANTHROPIC_API_KEY=sk-...   # optional: if set, Claude Haiku does the merge instead
```

You can also put these in the reviewed project's `.env`. Crit reads only `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, and `CRIT_*` from there; other project secrets are never touched. No
keys at all? Use `--mock-ai` to try the full loop with canned transcription.

## First run

Reload your agent, open any React app project (Next.js or Vite), and ask:

> "Give me a crit" (in Claude Code: `/crit`)

Your browser opens the mirrored app. Press **Start Crit**, allow the microphone, and talk
through your feedback while using your mouse as a pointer. A panel at the bottom left shows
the source file of whatever you're hovering. Press **Stop** when done. The agent receives
the review and gets to work; artifacts land in `.crit/reviews/<session>/`.

You can also run it without an agent:

```bash
npm i -g design-crit
crit review            # human-readable output; --json for machines
```

## What the agent gets back

```markdown
[00:03] On /dashboard, the user says the first impression feels cluttered.
        The pointer circles the main metrics cards.

[00:15] The user says "these two buttons should just be links" while pointing
        at the "Dashboard" and "Projects" buttons (src/App.jsx:12-13, <App>).
```

Plus structured issues and follow-ups the agent can act on directly, and a verbatim
speech-plus-pointer log as ground truth. Every element you point at is annotated with its
exact source location by the bundled [ion compiler](ion-compiler/README.md).

## How it works

```
crit review
 |- mirror the app into a temp dir (original source is never touched)
 |    - a Babel pass stamps data-ion-* source annotations on every JSX element
 |    - the recording widget script is injected
 |    - node_modules: APFS clone on macOS, symlink elsewhere, or --install
 |- start a localhost-only collector server
 |- start the app's own dev server from the mirror (next / vite / npm run dev)
 |- open the browser: the user records a narrated review
 |    - mic audio, mouse moves, clicks, scrolls, page changes
 |    - element context: tag, role, text, aria-label, source file/line/component
 |- on Stop: speech-to-text, condense the interaction log, AI merge
 '- write artifacts to .crit/reviews/<session>/, print the result, clean up
```

Full details (CLI flags, env vars, artifact formats, error codes, monorepos, limitations)
are in **[docs/crit.md](docs/crit.md)**.

<details>
<summary>Wiring an agent by hand (no installer)</summary>

Register a tool or command that shells out to `crit review --source . --json`. The call
blocks until the user finishes, so give it a generous timeout (reviews take minutes).
stdout is one JSON object: on `"status": "completed"`, read `final_transcript` (Markdown)
and `artifacts.review_json` (structured issues and timeline). `"cancelled"` means the user
declined; `"error"` carries `error.code` and partial artifact paths. The canonical skill
text lives at [skill/SKILL.md](skill/SKILL.md).

</details>

## Privacy

Everything is local-first. The collector binds to `127.0.0.1`, sessions use unguessable
ids, and nothing leaves your machine except the audio sent to your STT provider and two
text transcripts sent to your merge model. No screen video. Input values are never
recorded (password fields yield only their type). No cookies, storage, or headers are
captured. Recording only starts when you press Start, with a pulsing red indicator while
live.

## Repo layout

| Path | What |
| --- | --- |
| `bin/crit.js`, `src/` | CLI: orchestrator, mirror, app runner, collector, providers |
| `overlay/crit-overlay.js` | The in-browser recording widget and event capture |
| `ion-compiler/` | Babel plugin + directory processor (source annotations) |
| `test/` | Unit tests + `--mock-ai` end-to-end tests against a fixture app |
| `docs/crit.md` | Full documentation |

## Development

```bash
npm test                                  # full suite (no keys, no mic needed)
crit review --source test/fixtures/demo-app --mock-ai --no-open --json
```

Mock providers (`--mock-ai`) make the whole loop runnable headlessly. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
