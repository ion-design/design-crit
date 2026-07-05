/**
 * Post-recording processing pipeline:
 * raw events + audio → transcript + condensed timeline → merged review → artifacts.
 *
 * Degrades gracefully: if STT or merge fails, the raw artifacts that DID
 * succeed are still written, and the error carries the artifact paths.
 */

const fs = require('fs');
const path = require('path');
const { normalizeEvents, condenseEvents, timelineToText } = require('./events');
const { renderReviewMarkdown, writeJson, writeText, writeJsonl } = require('./artifacts');
const { log } = require('./util');

async function processSession({ rawEvents, audioBuffer, session, sttProvider, mergeProvider, artifactsDir }) {
  const artifacts = {};

  // 1. Raw interaction log
  artifacts.interaction_log = writeJsonl(artifactsDir, 'interaction_log.jsonl', rawEvents);

  // 2. Audio
  const audioPath = path.join(artifactsDir, 'audio.webm');
  fs.writeFileSync(audioPath, audioBuffer || Buffer.alloc(0));
  artifacts.audio = audioPath;

  // 3. Condensed interaction timeline
  const events = normalizeEvents(rawEvents);
  const interactionEntries = condenseEvents(events);
  artifacts.interaction_timeline = writeJson(artifactsDir, 'interaction_timeline.json', {
    entries: interactionEntries,
    text: timelineToText(interactionEntries),
  });

  // 4. Speech-to-text
  log(`transcribing audio with ${sttProvider.name} (${sttProvider.model})...`);
  let speech;
  try {
    speech = await sttProvider.transcribeAudio({
      audioPath,
      sessionId: session.sessionId,
      durationMs: session.durationMs,
    });
  } catch (e) {
    e.code = e.code || 'STT_FAILED';
    e.artifacts = artifacts;
    throw e;
  }
  artifacts.speech_transcript = writeJson(artifactsDir, 'speech_transcript.json', speech);

  // 5. AI merge
  log(`merging transcripts with ${mergeProvider.name} (${mergeProvider.model})...`);
  let merged;
  try {
    merged = await mergeProvider.mergeTranscripts({ speech, interactionEntries, session });
  } catch (e) {
    e.code = e.code || 'MERGE_FAILED';
    e.artifacts = artifacts;
    throw e;
  }
  artifacts.merged_timeline = writeJson(artifactsDir, 'merged_timeline.json', merged.timeline);

  // 6. Final review artifacts
  const reviewMarkdown = renderReviewMarkdown({ merged, session, speech, interactionEntries });
  artifacts.review_markdown = writeText(artifactsDir, 'review.md', reviewMarkdown);
  artifacts.review_json = writeJson(artifactsDir, 'review.json', {
    session_id: session.sessionId,
    duration_ms: session.durationMs,
    ...merged,
  });

  return { merged, reviewMarkdown, artifacts, interactionEntries, speech };
}

module.exports = { processSession };
