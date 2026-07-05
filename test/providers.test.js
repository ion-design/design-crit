const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSttProvider, MockSttProvider } = require('../src/providers/stt');
const { createMergeProvider, MockMergeProvider, buildMergeInput, parseModelJson } = require('../src/providers/merge');
const { normalizeEvents, condenseEvents } = require('../src/events');

const fixtureEvents = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events.json'), 'utf-8'));

test('provider factories', () => {
  assert.equal(createSttProvider('mock').name, 'mock');
  assert.equal(createSttProvider('openai').name, 'openai');
  assert.throws(() => createSttProvider('nope'));
  assert.equal(createMergeProvider('mock').name, 'mock');
  assert.equal(createMergeProvider('anthropic').name, 'anthropic');
  assert.equal(createMergeProvider('openai').name, 'openai');
  assert.throws(() => createMergeProvider('nope'));
});

test('mock STT returns timestamped segments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-test-'));
  const audioPath = path.join(dir, 'audio.webm');
  fs.writeFileSync(audioPath, Buffer.from('fake-webm-bytes'));

  const stt = new MockSttProvider({});
  const t = await stt.transcribeAudio({ audioPath, sessionId: 's', durationMs: 14000 });
  assert.ok(t.text.length > 0);
  assert.ok(Array.isArray(t.segments) && t.segments.length > 0);
  for (const seg of t.segments) {
    assert.equal(typeof seg.start_ms, 'number');
    assert.equal(typeof seg.end_ms, 'number');
    assert.ok(seg.end_ms >= seg.start_ms);
    assert.equal(typeof seg.text, 'string');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mock STT handles missing audio', async () => {
  const stt = new MockSttProvider({});
  const t = await stt.transcribeAudio({ audioPath: '/nonexistent/audio.webm', durationMs: 5000 });
  assert.ok(t.text.includes('no audio'));
});

test('buildMergeInput includes both transcripts with timestamps', () => {
  const speech = { text: 'x', segments: [{ start_ms: 3000, end_ms: 6000, text: 'The page feels heavy.' }] };
  const entries = condenseEvents(normalizeEvents(fixtureEvents));
  const input = buildMergeInput({ speech, interactionEntries: entries, session: { sessionId: 's1', durationMs: 14000 } });
  assert.ok(input.includes('## Speech transcript'));
  assert.ok(input.includes('[00:03–00:06] The page feels heavy.'));
  assert.ok(input.includes('## Interaction timeline'));
  assert.ok(input.includes('User clicks “Create project” button in <App>'));
  assert.ok(input.includes('Session: s1'));
});

test('parseModelJson tolerates fences and prose', () => {
  const m = parseModelJson('Here you go:\n```json\n{"summary":"s","timeline":[],"issues":[],"suggested_followups":["a"]}\n```');
  assert.equal(m.summary, 's');
  assert.deepEqual(m.suggested_followups, ['a']);
  assert.throws(() => parseModelJson('no json here'));
});

test('parseModelJson sanitizes malformed shapes', () => {
  const m = parseModelJson('{"summary": 42, "timeline": [{"start_ms":"3000","merged_note":"n"}], "issues": "x"}');
  assert.equal(m.summary, '');
  assert.equal(m.timeline[0].start_ms, 3000);
  assert.equal(m.timeline[0].merged_note, 'n');
  assert.deepEqual(m.issues, []);
});

test('mock merge pairs speech with interaction context', async () => {
  const speech = {
    text: '',
    segments: [
      { start_ms: 0, end_ms: 6000, text: 'First impression is cluttered.' },
      { start_ms: 6500, end_ms: 12000, text: 'I clicked create project and the form is clearer.' },
    ],
  };
  const entries = condenseEvents(normalizeEvents(fixtureEvents));
  const merge = new MockMergeProvider({});
  const merged = await merge.mergeTranscripts({ speech, interactionEntries: entries, session: { sessionId: 's' } });

  assert.equal(merged.timeline.length, 2);
  assert.equal(merged.timeline[0].spoken_text, 'First impression is cluttered.');
  assert.ok(merged.timeline[1].interaction_context.includes('Create project'), merged.timeline[1].interaction_context);
  assert.ok(merged.summary.length > 0);
  assert.ok(Array.isArray(merged.issues));
  assert.ok(Array.isArray(merged.suggested_followups));
});
