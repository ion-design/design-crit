/**
 * Local Crit collector server.
 *
 * Localhost-only HTTP server the browser overlay talks to:
 *   GET  /crit/session      — session info + state
 *   GET  /crit/status       — polling endpoint for the overlay while processing
 *   POST /crit/start        — recording started (resets buffers)
 *   POST /crit/events       — batched interaction events
 *   POST /crit/audio-chunk  — binary audio chunk (?seq=N)
 *   POST /crit/restart      — discard current recording, back to idle
 *   POST /crit/stop         — finalize: triggers the processing pipeline
 *   POST /crit/cancel       — cancel the whole session
 *
 * Requests must carry the correct session id (query param or JSON body).
 */

const http = require('http');
const { log } = require('./util');

const MAX_JSON_BODY = 20 * 1024 * 1024;
const MAX_AUDIO_CHUNK = 100 * 1024 * 1024;

function createCollector({ sessionId, onFinalize }) {
  const state = {
    phase: 'waiting', // waiting | recording | processing | completed | error | cancelled
    events: [],
    audioChunks: [],
    startedAt: null, // wall time of first recording start
    recordingStartedAt: null,
    error: null,
  };

  let resolveDone;
  const whenDone = new Promise((r) => (resolveDone = r));
  let finished = false;
  let finalPolled = false;
  const finalPollResolvers = [];
  const finish = (result) => {
    if (finished) return;
    finished = true;
    resolveDone(result);
  };

  const server = http.createServer(async (req, res) => {
    // CORS: the app runs on a different localhost port than the collector.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'GET /crit/session': {
          if (!checkSession(url.searchParams.get('sessionId'))) return deny(res);
          return json(res, 200, { sessionId, state: state.phase });
        }
        case 'GET /crit/status': {
          if (!checkSession(url.searchParams.get('sessionId'))) return deny(res);
          json(res, 200, { state: state.phase, error: state.error ? state.error.message : null });
          // Let the CLI know the overlay has seen a terminal state, so it can
          // shut down without leaving the widget stuck on "Processing…".
          if (state.phase === 'completed' || state.phase === 'error') {
            for (const r of finalPollResolvers.splice(0)) r();
            finalPolled = true;
          }
          return;
        }
        case 'POST /crit/start': {
          const body = await readJson(req);
          if (!checkSession(body.sessionId)) return deny(res);
          if (state.phase === 'processing' || state.phase === 'completed') {
            return json(res, 409, { error: 'session is already finalizing' });
          }
          state.events = [];
          state.audioChunks = [];
          state.phase = 'recording';
          state.recordingStartedAt = new Date().toISOString();
          if (!state.startedAt) state.startedAt = state.recordingStartedAt;
          log('recording started');
          return json(res, 200, { ok: true });
        }
        case 'POST /crit/events': {
          const body = await readJson(req);
          if (!checkSession(body.sessionId)) return deny(res);
          if (Array.isArray(body.events)) {
            for (const ev of body.events) state.events.push(ev);
          }
          return json(res, 200, { ok: true, count: state.events.length });
        }
        case 'POST /crit/audio-chunk': {
          if (!checkSession(url.searchParams.get('sessionId'))) return deny(res);
          const seq = Number(url.searchParams.get('seq') || state.audioChunks.length);
          const buf = await readRaw(req, MAX_AUDIO_CHUNK);
          state.audioChunks.push({ seq, buf });
          return json(res, 200, { ok: true, bytes: buf.length });
        }
        case 'POST /crit/restart': {
          const body = await readJson(req);
          if (!checkSession(body.sessionId)) return deny(res);
          if (state.phase === 'processing') return json(res, 409, { error: 'already processing' });
          state.events = [];
          state.audioChunks = [];
          state.phase = 'waiting';
          log('recording restarted (buffers cleared)');
          return json(res, 200, { ok: true });
        }
        case 'POST /crit/stop': {
          const body = await readJson(req);
          if (!checkSession(body.sessionId)) return deny(res);
          if (state.phase !== 'recording') return json(res, 409, { error: `cannot stop from state "${state.phase}"` });
          state.phase = 'processing';
          const durationMs = Number(body.duration_ms) || 0;
          log(`recording stopped (${Math.round(durationMs / 1000)}s) — processing...`);
          json(res, 200, { ok: true, state: 'processing' });

          // Run the pipeline outside the request cycle; overlay polls /crit/status.
          const audioBuffer = Buffer.concat(
            state.audioChunks.sort((a, b) => a.seq - b.seq).map((c) => c.buf)
          );
          const payload = {
            rawEvents: state.events.slice(),
            audioBuffer,
            durationMs,
            startedAt: state.recordingStartedAt,
          };
          Promise.resolve()
            .then(() => onFinalize(payload))
            .then((result) => {
              state.phase = 'completed';
              finish({ outcome: 'completed', ...result, startedAt: payload.startedAt, durationMs });
            })
            .catch((err) => {
              state.phase = 'error';
              state.error = err;
              finish({ outcome: 'error', error: err, startedAt: payload.startedAt, durationMs });
            });
          return;
        }
        case 'POST /crit/cancel': {
          const body = await readJson(req);
          if (!checkSession(body.sessionId)) return deny(res);
          state.phase = 'cancelled';
          log('session cancelled by user');
          json(res, 200, { ok: true });
          finish({ outcome: 'cancelled', reason: body.reason || 'user_cancelled' });
          return;
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'body too large' });
      log('collector error:', err.message);
      return json(res, 400, { error: err.message });
    }
  });

  function checkSession(id) {
    return id === sessionId;
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  return {
    server,
    listen,
    whenDone,
    getState: () => state.phase,
    cancelFromCli: (reason) => {
      state.phase = 'cancelled';
      finish({ outcome: 'cancelled', reason: reason || 'user_cancelled' });
    },
    /** Resolve once the overlay has polled a terminal status (or after timeoutMs). */
    waitForFinalPoll: (timeoutMs = 10000) =>
      new Promise((resolve) => {
        if (finalPolled) return resolve();
        const t = setTimeout(resolve, timeoutMs);
        finalPollResolvers.push(() => {
          clearTimeout(t);
          resolve();
        });
      }),
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function deny(res) {
  return json(res, 403, { error: 'unknown session' });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readRaw(req, MAX_JSON_BODY);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf-8'));
}

module.exports = { createCollector };
