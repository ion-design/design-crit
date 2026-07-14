# Contributing to Crit

Thanks for your interest! Crit is intentionally small and dependency-light: the CLI and
collector are plain Node (only Babel packages as dependencies), and the browser overlay is a
single vanilla-JS file.

## Setup

```bash
npm install
npm test          # full suite: unit tests + end-to-end runs with mock AI providers
npm link          # optional: `crit` on your PATH
```

Everything runs without API keys or a microphone — `--mock-ai` swaps in deterministic
transcription/merge providers, and the e2e tests drive the collector over HTTP exactly like the
browser widget does.

## Handy loops

```bash
# full loop against the fixture app, headless
crit review --source test/fixtures/demo-app --mock-ai --no-open --json

# keep the mirrored temp app around for inspection
crit review --source <app> --mock-ai --keep-temp
```

## Where things live

- `src/cli.js` — orchestrator/lifecycle; all logging to stderr, stdout is the result only
- `src/events.js` — event normalization + timeline condensation (pure functions; test here)
- `src/collector.js` — localhost HTTP server the overlay talks to
- `src/providers/` — STT + merge providers; add a provider by implementing the small class
  interface and registering it in the factory
- `overlay/crit-overlay.js` — the widget; keep it dependency-free and ES5-ish
- `ion-compiler/` — the Babel annotation/mirroring pipeline (see its `README.md`)

## Guidelines

- Privacy is a hard constraint: never capture input values, cookies, storage, or headers in the
  overlay. New target metadata must be safe by construction.
- `--json` stdout must remain a single valid JSON object — put any new output on stderr.
- Add or extend a test for any behavior change; `test/e2e.test.js` covers the full loop.
