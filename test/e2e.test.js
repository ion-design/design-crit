/**
 * End-to-end happy path with --mock-ai: spawns the real CLI against the
 * fixture app, then plays the browser's role over HTTP (start recording,
 * stream events + audio chunks, stop) and verifies the final JSON + artifacts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'crit.js');
const FIXTURE_APP = path.join(__dirname, 'fixtures', 'demo-app');
const fixtureEvents = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events.json'), 'utf-8'));

function waitFor(getter, { timeoutMs = 60000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function check() {
      const v = await getter();
      if (v) return resolve(v);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(check, intervalMs);
    })();
  });
}

test('crit review --mock-ai end-to-end', { timeout: 120000 }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-e2e-out-'));
  const proc = spawn(process.execPath, [
    CLI, 'review',
    '--source', FIXTURE_APP,
    '--out', outDir,
    '--mock-ai', '--no-open', '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));

  try {
    // Parse session id, collector URL, app URL from the CLI's stderr logs
    const sessionId = (await waitFor(() => stderr.match(/session (crit_[a-z0-9_]+)/)?.[1], { label: 'session id' }));
    const collectorUrl = await waitFor(() => stderr.match(/collector listening at (\S+)/)?.[1], { label: 'collector url' });
    const appUrl = await waitFor(() => stderr.match(/app running at (\S+)/)?.[1], { timeoutMs: 90000, label: 'app url' });

    // The served app must include the overlay script tag and serve the overlay
    // with the session config baked in.
    const html = await (await fetch(appUrl)).text();
    assert.ok(html.includes('/crit-overlay.js'), 'app HTML should reference the overlay script');
    const overlayJs = await (await fetch(appUrl + '/crit-overlay.js')).text();
    assert.ok(overlayJs.includes(sessionId), 'overlay should have the session id baked in');
    assert.ok(overlayJs.includes(collectorUrl), 'overlay should have the collector url baked in');

    // The mirrored JSX should carry ion source annotations
    const state = await (await fetch(`${collectorUrl}/crit/session?sessionId=${sessionId}`)).json();
    assert.equal(state.state, 'waiting');

    // Unknown session ids are rejected
    const bad = await fetch(`${collectorUrl}/crit/session?sessionId=nope`);
    assert.equal(bad.status, 403);

    // ---- Play the browser role ----
    const post = (p, body) =>
      fetch(collectorUrl + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      });

    let res = await post('/crit/start', {});
    assert.equal(res.status, 200);

    // stop from waiting state must 409 — but we're recording now, so restart works
    res = await post('/crit/restart', {});
    assert.equal(res.status, 200);
    res = await post('/crit/stop', { duration_ms: 1 });
    assert.equal(res.status, 409, 'stop without recording should 409');

    res = await post('/crit/start', {});
    assert.equal(res.status, 200);

    res = await post('/crit/events', { events: fixtureEvents });
    assert.equal(res.status, 200);

    // two audio chunks
    for (let seq = 0; seq < 2; seq++) {
      res = await fetch(`${collectorUrl}/crit/audio-chunk?sessionId=${sessionId}&seq=${seq}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(`fake-audio-chunk-${seq}`),
      });
      assert.equal(res.status, 200);
    }

    res = await post('/crit/stop', { duration_ms: 14000 });
    assert.equal(res.status, 200);

    // Poll status like the overlay does; the CLI waits for this final poll
    // before tearing down, so the widget can show "completed".
    const finalState = await waitFor(async () => {
      try {
        const s = await (await fetch(`${collectorUrl}/crit/status?sessionId=${sessionId}`)).json();
        return s.state === 'completed' || s.state === 'error' ? s.state : null;
      } catch {
        return null;
      }
    }, { label: 'terminal status' });
    assert.equal(finalState, 'completed');

    const exitCode = await exited;
    assert.equal(exitCode, 0, `CLI should exit 0.\nstderr:\n${stderr}`);

    // ---- Verify stdout JSON ----
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'completed');
    assert.equal(result.session_id, sessionId);
    assert.equal(result.duration_ms, 14000);
    assert.ok(result.final_transcript.startsWith('# Crit Review'));
    assert.ok(result.final_transcript.includes('## Summary'));
    assert.ok(result.final_transcript.includes('## Timeline'));
    assert.ok(result.final_transcript.includes('## Verbatim Transcript'));
    assert.ok(result.final_transcript.includes('**User:**'));

    // ---- Verify artifacts on disk ----
    const dir = path.join(outDir, sessionId);
    for (const f of [
      'review.md', 'review.json', 'audio.webm', 'speech_transcript.json',
      'interaction_log.jsonl', 'interaction_timeline.json', 'merged_timeline.json', 'session.json',
    ]) {
      assert.ok(fs.existsSync(path.join(dir, f)), `missing artifact ${f}`);
    }
    const audio = fs.readFileSync(path.join(dir, 'audio.webm'));
    assert.equal(audio.toString(), 'fake-audio-chunk-0fake-audio-chunk-1', 'audio chunks concatenated in order');

    const logLines = fs.readFileSync(path.join(dir, 'interaction_log.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(logLines.length, fixtureEvents.length);

    const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'interaction_timeline.json'), 'utf-8'));
    assert.ok(timeline.text.includes('User clicks “Create project” button in <App>'));

    const sessionJson = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf-8'));
    assert.equal(sessionJson.status, 'completed');
    assert.equal(sessionJson.stt_provider, 'mock');
    assert.equal(sessionJson.merge_provider, 'mock');

    const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf-8'));
    assert.ok(Array.isArray(review.timeline) && review.timeline.length > 0);
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('crit review cancellation', { timeout: 120000 }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-e2e-cancel-'));
  const proc = spawn(process.execPath, [
    CLI, 'review', '--source', FIXTURE_APP, '--out', outDir, '--mock-ai', '--no-open', '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));

  try {
    const sessionId = await waitFor(() => stderr.match(/session (crit_[a-z0-9_]+)/)?.[1], { label: 'session id' });
    const collectorUrl = await waitFor(() => stderr.match(/collector listening at (\S+)/)?.[1], { label: 'collector url' });
    await waitFor(() => stderr.includes('app running'), { timeoutMs: 90000, label: 'app up' });

    const res = await fetch(collectorUrl + '/crit/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reason: 'user_cancelled' }),
    });
    assert.equal(res.status, 200);

    const exitCode = await exited;
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.reason, 'user_cancelled');
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
