---
name: crit
description: Request a Crit — a narrated design review of the running app from the user. Use when you want human design/product feedback on UI you built or changed, when the user should look at the app and react to it, or when the user says things like "crit", "get my feedback", "review this with me", or "I'll talk you through it". Opens the app in a local review runner; returns a timestamped transcript of spoken feedback with pointer and source-file context.
---

# Crit — ask the user for a narrated app review

Crit opens the user's browser on a mirrored copy of the current app with a recording widget.
The user narrates feedback out loud while pointing with their mouse. You get back a merged,
timestamped review transcript where references like "this button" are resolved to concrete
elements **with source file, line, and component** — enough context to act without guessing.

## 1. Ensure the CLI is available

```bash
command -v crit || npm install -g design-crit
```

(If a global install isn't possible, `npx -y design-crit review ...` works too.)

## 2. Check for API keys

Crit needs `OPENAI_API_KEY` (speech-to-text; also covers the merge). `ANTHROPIC_API_KEY` is
optional (Claude then does the merge). Keys are read from your shell environment first, then
from the project's `.env`/`.env.local`. If neither has a key, tell the user and either ask them
to add one or run with `--mock-ai` (interaction context only, placeholder transcript).

## 3. Request the Crit

Tell the user: "I'm requesting a Crit — your browser will open. Press Start, talk through your
feedback while pointing with your mouse, and press Stop when you're done."

Then run (long timeout — the command blocks while the user reviews, often several minutes):

```bash
crit review --source . --json
```

## 4. Consume the result

stdout is a single JSON object:

- `"status": "completed"` — read `final_transcript` (timestamped Markdown review). The
  `artifacts.review_json` file has the same content structured: `issues[]` (title, evidence,
  timestamp, url), `timeline[]`, `suggested_followups[]`. Interaction context includes source
  anchors like `src/components/Hero.tsx:42 <Hero>` — use them to open the exact code the user
  pointed at.
- `"status": "cancelled"` — the user declined; do not relaunch without asking.
- `"status": "error"` — report `error.code` and `error.message`; partial artifacts (raw speech
  transcript, interaction timeline) may still be listed in `artifacts`.

## 5. Act on it

Summarize the issues back to the user, map each to its source location (the anchors are in the
transcript), propose concrete changes, and implement the unambiguous ones. Where the review
says the target was unclear, ask the user rather than guessing. After making changes, offer
another Crit to verify.
