/**
 * Speech-to-text provider interface.
 *
 * transcribeAudio({ audioPath, sessionId, durationMs }) → SpeechTranscript
 *   { text: string, segments: [{ start_ms, end_ms, text }] }
 */

const fs = require('fs');
const path = require('path');

const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions';

class OpenAISttProvider {
  constructor({ model, apiKey } = {}) {
    this.name = 'openai';
    this.model = model || 'whisper-1';
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
  }

  async transcribeAudio({ audioPath }) {
    if (!this.apiKey) {
      const err = new Error('OPENAI_API_KEY is not set (required for speech-to-text). Use --mock-ai for local testing.');
      err.code = 'STT_FAILED';
      throw err;
    }
    const buf = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/webm' }), path.basename(audioPath));
    form.append('model', this.model);
    // whisper-1 supports verbose_json with segment timestamps
    form.append('response_format', 'verbose_json');

    const res = await fetch(OPENAI_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenAI transcription failed (${res.status}): ${body.slice(0, 500)}`);
      err.code = 'STT_FAILED';
      throw err;
    }
    const data = await res.json();
    const segments = Array.isArray(data.segments)
      ? data.segments.map((s) => ({
          start_ms: Math.round((s.start || 0) * 1000),
          end_ms: Math.round((s.end || 0) * 1000),
          text: String(s.text || '').trim(),
        }))
      : [{ start_ms: 0, end_ms: Math.round((data.duration || 0) * 1000), text: String(data.text || '').trim() }];
    return { text: String(data.text || '').trim(), segments };
  }
}

class MockSttProvider {
  constructor({ model } = {}) {
    this.name = 'mock';
    this.model = model || 'mock-stt-1';
  }

  async transcribeAudio({ audioPath, durationMs }) {
    let hasAudio = false;
    try {
      hasAudio = fs.statSync(audioPath).size > 0;
    } catch {
      hasAudio = false;
    }
    const total = Math.max(durationMs || 0, 4000);
    const lines = hasAudio
      ? [
          'This is a mock transcription of the recorded audio.',
          'The first thing I notice is the overall layout of the page.',
          'I would expect the primary action to stand out more than it does.',
          'Overall this flow makes sense but the hierarchy could be clearer.',
        ]
      : [
          '(mock transcript — no audio was captured for this session)',
          'The user completed a silent review; see the interaction timeline for context.',
        ];
    const step = Math.floor(total / lines.length);
    const segments = lines.map((text, i) => ({
      start_ms: i * step,
      end_ms: Math.min((i + 1) * step, total),
      text,
    }));
    return { text: lines.join(' '), segments };
  }
}

function createSttProvider(name, opts = {}) {
  switch ((name || 'openai').toLowerCase()) {
    case 'openai':
      return new OpenAISttProvider(opts);
    case 'mock':
      return new MockSttProvider(opts);
    default:
      throw new Error(`Unknown STT provider "${name}". Supported: openai, mock`);
  }
}

module.exports = { createSttProvider, OpenAISttProvider, MockSttProvider };
