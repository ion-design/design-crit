/**
 * Transcript merge provider interface.
 *
 * mergeTranscripts({ speech, interactionEntries, session }) → MergedReview
 *   {
 *     summary: string,
 *     timeline: [{ start_ms, end_ms, url, spoken_text, interaction_context, merged_note }],
 *     issues: [{ title, evidence, timestamp_ms, url }],
 *     suggested_followups: [string]
 *   }
 */

const { formatClock } = require('../util');
const { timelineToText } = require('../events');

const MERGE_SYSTEM_PROMPT = `You are merging a narrated product/design review with browser interaction context.

You will receive:
1. A timestamped speech transcript.
2. A timestamped interaction timeline containing page changes, pointer movement summaries, clicks, scrolls, and target element context.

Create a final Crit transcript for an AI coding/design agent.

Rules:
- Preserve the user's actual feedback.
- Do not invent feedback.
- Use interaction context only to clarify what the user was likely referring to.
- Mention page URLs when useful.
- Mention clicks, hovers, pointer pauses, and page changes when they clarify the spoken feedback.
- Do not include noisy mouse movement details.
- If the user says "this" or "here," use the pointer/page context to clarify what "this" or "here" likely refers to.
- If context is ambiguous, say so briefly rather than guessing.
- When interaction context includes a source component or file, keep it — the agent can use it to locate the code.

Respond with ONLY a JSON object (no markdown fences, no prose) with this exact shape:
{
  "summary": "2-4 sentence summary of the review",
  "timeline": [
    {
      "start_ms": 3000,
      "end_ms": 17000,
      "url": "/dashboard",
      "spoken_text": "what the user actually said in this window",
      "interaction_context": "what they were doing/pointing at",
      "merged_note": "one merged sentence combining both"
    }
  ],
  "issues": [
    { "title": "short issue title", "evidence": "what the user said/did that shows this", "timestamp_ms": 17000, "url": "/dashboard" }
  ],
  "suggested_followups": ["actionable follow-up for the agent"]
}`;

/** Build the user-message payload sent to the merge model. Exported for tests. */
function buildMergeInput({ speech, interactionEntries, session }) {
  const speechLines = (speech.segments || [])
    .map((s) => `[${formatClock(s.start_ms)}–${formatClock(s.end_ms)}] ${s.text}`)
    .join('\n');
  const interactionText = timelineToText(interactionEntries || []);
  return [
    `Session: ${session.sessionId}`,
    `Duration: ${formatClock(session.durationMs || 0)}`,
    '',
    '## Speech transcript',
    speechLines || '(no speech was transcribed)',
    '',
    '## Interaction timeline',
    interactionText || '(no interactions were recorded)',
  ].join('\n');
}

/** Tolerant JSON extraction from a model response. */
function parseModelJson(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in model response');
  const parsed = JSON.parse(t.slice(start, end + 1));
  return sanitizeMerged(parsed);
}

function sanitizeMerged(m) {
  return {
    summary: typeof m.summary === 'string' ? m.summary : '',
    timeline: Array.isArray(m.timeline)
      ? m.timeline.map((x) => ({
          start_ms: Number(x.start_ms) || 0,
          end_ms: Number(x.end_ms) || 0,
          url: typeof x.url === 'string' ? x.url : null,
          spoken_text: typeof x.spoken_text === 'string' ? x.spoken_text : '',
          interaction_context: typeof x.interaction_context === 'string' ? x.interaction_context : '',
          merged_note: typeof x.merged_note === 'string' ? x.merged_note : '',
        }))
      : [],
    issues: Array.isArray(m.issues)
      ? m.issues.map((x) => ({
          title: typeof x.title === 'string' ? x.title : '',
          evidence: typeof x.evidence === 'string' ? x.evidence : '',
          timestamp_ms: Number(x.timestamp_ms) || 0,
          url: typeof x.url === 'string' ? x.url : null,
        }))
      : [],
    suggested_followups: Array.isArray(m.suggested_followups) ? m.suggested_followups.map(String) : [],
  };
}

class AnthropicMergeProvider {
  constructor({ model, apiKey } = {}) {
    this.name = 'anthropic';
    this.model = model || 'claude-haiku-4-5-20251001';
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
  }

  async mergeTranscripts(input) {
    if (!this.apiKey) {
      const err = new Error('ANTHROPIC_API_KEY is not set (required for transcript merge). Use --mock-ai for local testing.');
      err.code = 'MERGE_FAILED';
      throw err;
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: MERGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildMergeInput(input) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Anthropic merge failed (${res.status}): ${body.slice(0, 500)}`);
      err.code = 'MERGE_FAILED';
      throw err;
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return parseModelJson(text);
  }
}

class OpenAIMergeProvider {
  constructor({ model, apiKey } = {}) {
    this.name = 'openai';
    // gpt-4.1-mini balances merge quality and post-Stop latency (~5s);
    // gpt-4.1-nano is faster but weaker on long reviews, gpt-5-* are
    // reasoning models and take 15s+ for this task.
    this.model = model || 'gpt-4.1-mini';
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
  }

  async mergeTranscripts(input) {
    if (!this.apiKey) {
      const err = new Error('OPENAI_API_KEY is not set (required for transcript merge). Use --mock-ai for local testing.');
      err.code = 'MERGE_FAILED';
      throw err;
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: MERGE_SYSTEM_PROMPT },
          { role: 'user', content: buildMergeInput(input) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenAI merge failed (${res.status}): ${body.slice(0, 500)}`);
      err.code = 'MERGE_FAILED';
      throw err;
    }
    const data = await res.json();
    return parseModelJson(data.choices?.[0]?.message?.content || '');
  }
}

/**
 * Deterministic merge with no AI: pairs each speech segment with the
 * interaction entries that overlap its time window.
 */
class MockMergeProvider {
  constructor({ model } = {}) {
    this.name = 'mock';
    this.model = model || 'mock-merge-1';
  }

  async mergeTranscripts({ speech, interactionEntries }) {
    const segments = speech.segments || [];
    const entries = interactionEntries || [];
    const timeline = segments.map((seg, i) => {
      const windowEnd = i === segments.length - 1 ? Infinity : segments[i + 1].start_ms;
      const context = entries
        .filter((e) => e.start_ms >= seg.start_ms - 1500 && e.start_ms < Math.max(seg.end_ms, windowEnd))
        .map((e) => e.text);
      const url = entries.filter((e) => e.kind === 'page' && e.start_ms <= seg.end_ms).map((e) => e.url).pop() || null;
      const ctx = context.slice(0, 3).join('; ');
      return {
        start_ms: seg.start_ms,
        end_ms: seg.end_ms,
        url,
        spoken_text: seg.text,
        interaction_context: ctx,
        merged_note: ctx ? `${seg.text} (while: ${ctx})` : seg.text,
      };
    });
    return {
      summary:
        segments.length > 0
          ? `Mock merge of ${segments.length} speech segment(s) and ${entries.length} interaction event group(s). First remark: ${segments[0].text}`
          : `Mock merge: no speech segments; ${entries.length} interaction event group(s).`,
      timeline,
      issues: [],
      suggested_followups: [],
    };
  }
}

function createMergeProvider(name, opts = {}) {
  switch ((name || 'anthropic').toLowerCase()) {
    case 'anthropic':
      return new AnthropicMergeProvider(opts);
    case 'openai':
      return new OpenAIMergeProvider(opts);
    case 'mock':
      return new MockMergeProvider(opts);
    default:
      throw new Error(`Unknown merge provider "${name}". Supported: anthropic, openai, mock`);
  }
}

module.exports = {
  createMergeProvider,
  buildMergeInput,
  parseModelJson,
  MERGE_SYSTEM_PROMPT,
  AnthropicMergeProvider,
  OpenAIMergeProvider,
  MockMergeProvider,
};
