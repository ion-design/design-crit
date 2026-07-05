/**
 * Artifact rendering + writing for a Crit session.
 */

const fs = require('fs');
const path = require('path');
const { formatClock } = require('./util');

/**
 * Deterministic interleave of verbatim speech segments and condensed
 * interaction entries, ordered by timestamp. No AI involved — this section
 * can never lose or paraphrase what the user actually said.
 */
function renderVerbatimTranscript(speech, interactionEntries) {
  const rows = [];
  for (const s of speech?.segments || []) {
    rows.push({ t: s.start_ms, text: `**User:** “${s.text.trim()}”` });
  }
  for (const e of interactionEntries || []) {
    rows.push({ t: e.start_ms, text: `_${e.text}_` });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.map((r) => `[${formatClock(r.t)}] ${r.text}`).join('\n');
}

function renderReviewMarkdown({ merged, session, speech, interactionEntries }) {
  const lines = [];
  lines.push('# Crit Review');
  lines.push('');
  lines.push(`Session: ${session.sessionId}  `);
  lines.push(`Duration: ${formatClock(session.durationMs || 0)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(merged.summary || '(no summary)');
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  if (merged.timeline.length === 0) {
    lines.push('(empty timeline)');
  }
  for (const t of merged.timeline) {
    const url = t.url ? ` On \`${t.url}\`,` : '';
    const note = t.merged_note || t.spoken_text || t.interaction_context || '';
    lines.push(`[${formatClock(t.start_ms)}]${url ? '' : ''} ${note}`.trim());
    lines.push('');
  }
  if (merged.issues.length > 0) {
    lines.push('## Notable Issues');
    lines.push('');
    merged.issues.forEach((iss, i) => {
      const where = [iss.url ? `on \`${iss.url}\`` : null, iss.timestamp_ms ? `at ${formatClock(iss.timestamp_ms)}` : null]
        .filter(Boolean)
        .join(', ');
      lines.push(`${i + 1}. **${iss.title}** — ${iss.evidence}${where ? ` (${where})` : ''}`);
    });
    lines.push('');
  }
  if (merged.suggested_followups.length > 0) {
    lines.push('## Suggested Follow-Ups for the Agent');
    lines.push('');
    for (const f of merged.suggested_followups) lines.push(`- ${f}`);
    lines.push('');
  }
  const verbatim = renderVerbatimTranscript(speech, interactionEntries);
  if (verbatim) {
    lines.push('## Verbatim Transcript');
    lines.push('');
    lines.push('Exact speech (via STT) interleaved with interaction context — no AI rewriting.');
    lines.push('');
    lines.push(verbatim);
    lines.push('');
  }
  return lines.join('\n');
}

function writeJson(dir, name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  return p;
}

function writeText(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf-8');
  return p;
}

function writeJsonl(dir, name, rows) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8');
  return p;
}

module.exports = { renderReviewMarkdown, renderVerbatimTranscript, writeJson, writeText, writeJsonl };
