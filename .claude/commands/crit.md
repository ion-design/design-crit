---
description: "Request a Crit: opens the app in a local review runner so the user can narrate feedback while pointing and navigating. Returns a timestamped review transcript with spoken feedback plus page/mouse context."
allowed-tools: ["Bash"]
---

Request a Crit review of the current app from the user.

Run this from the app's directory (it blocks until the user finishes or cancels the review in
their browser — this can take several minutes, so use a long timeout):

```bash
crit review --source . --json
```

Add `--path /some/route` to land the reviewer on a specific page (do this when the feedback
you want concerns a particular route you just worked on).

(`crit` comes from `npm i -g design-crit`; if it is not on PATH, use `npx -y design-crit`.)

Notes:
- The user's browser opens automatically to a mirrored copy of the app with a recording widget.
  Tell the user: "I'm requesting a Crit — your browser will open. Press Start, talk through
  your feedback while pointing with your mouse, and press Stop when done."
- stdout is a single JSON object. On `"status": "completed"`, read `final_transcript` (a
  timestamped Markdown review) and the `artifacts` paths (`review.json` has structured
  issues/timeline).
- On `"status": "cancelled"`, the user declined — do not retry without asking.
- On `"status": "error"`, report `error.code`/`error.message`; partial artifacts may still be
  listed.
- Requires `OPENAI_API_KEY` (speech-to-text) and optionally `ANTHROPIC_API_KEY` (transcript
  merge). For a dry run without keys, add `--mock-ai`.

After the Crit completes: summarize the issues found, map them to source files (interaction
events include `source.file`/`source.component` from the ion compiler annotations), and propose
concrete changes.

$ARGUMENTS
