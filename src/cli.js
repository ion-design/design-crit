/**
 * crit CLI orchestrator.
 *
 * Owns the whole session lifecycle: mirror → inject → run app → collect →
 * transcribe → merge → artifacts → print result. Blocks until the user
 * completes or cancels the review in the browser.
 */

const fs = require('fs');
const path = require('path');
const { parseCliArgs, resolveProviders } = require('./args');
const { loadProjectEnv } = require('./env');
const { makeSessionId, createSessionDirs } = require('./session');
const { mirrorApp, provisionNodeModules, linkEnvFiles, injectOverlay } = require('./mirror');
const { startAppRunner } = require('./runner');
const { createCollector } = require('./collector');
const { processSession } = require('./pipeline');
const { createSttProvider } = require('./providers/stt');
const { createMergeProvider } = require('./providers/merge');
const { writeJson } = require('./artifacts');
const { log, findFreePort, openBrowser } = require('./util');

async function main(argv) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    return 1;
  }
  if (args.command === 'help') {
    process.stdout.write(args.help);
    return 0;
  }
  return runReview(args);
}

async function runReview(args) {
  const sessionId = makeSessionId();
  const sourceDir = path.resolve(args.source);
  const outDir = args.out ? path.resolve(args.out) : path.join(sourceDir, '.crit', 'reviews');

  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    return fail(args, sessionId, 'MIRROR_FAILED', `No package.json found in ${sourceDir} — is it an app directory?`);
  }

  // Top up crit's env (API keys, CRIT_* settings) from the project's .env
  // files — the calling process env always wins. Never log the values.
  const appliedEnv = loadProjectEnv(sourceDir);
  if (appliedEnv.length > 0) log(`loaded from project .env: ${appliedEnv.join(', ')}`);
  const providerConfig = resolveProviders(args);

  let dirs;
  try {
    dirs = createSessionDirs({ sessionId, sourceDir, outDir, tempDir: args.tempDir });
  } catch (e) {
    return fail(args, sessionId, 'TEMP_DIR_FAILED', `Could not create session directories: ${e.message}`);
  }
  log(`session ${sessionId}`);
  log(`mirroring ${sourceDir} → ${dirs.mirrorDir}`);

  let runner = null;
  let collector = null;
  const cleanup = async () => {
    try { if (runner) runner.stop(); } catch { /* ignore */ }
    try { if (collector) await collector.close(); } catch { /* ignore */ }
    if (!args.keepTemp) {
      try {
        fs.rmSync(dirs.tempCreatedByUs ? dirs.tempRoot : dirs.mirrorDir, { recursive: true, force: true });
      } catch (e) {
        log('warning: could not remove temp dir:', e.message);
      }
    } else {
      log(`temp mirror kept at ${dirs.mirrorDir}`);
    }
  };

  try {
    // 1. Mirror the app through the ion compiler pipeline
    const mirrorResult = await mirrorApp({ sourceDir, mirrorDir: dirs.mirrorDir });
    log(`mirrored: ${mirrorResult.processed} transformed, ${mirrorResult.copied} copied`);
    const nmMode = provisionNodeModules({ sourceDir, mirrorDir: dirs.mirrorDir, install: args.install });
    log(`node_modules: ${nmMode}`);
    linkEnvFiles({ sourceDir, mirrorDir: dirs.mirrorDir });

    // 2. Ports + overlay config
    const collectorPort = await findFreePort();
    const appPort = await findFreePort(args.port || undefined);
    const collectorUrl = `http://127.0.0.1:${collectorPort}`;
    injectOverlay({
      mirrorDir: dirs.mirrorDir,
      config: { sessionId, collectorUrl, recordingEnabled: true },
    });

    // 3. Providers (fail fast on unknown names)
    const sttProvider = createSttProvider(providerConfig.sttProvider, { model: providerConfig.sttModel });
    const mergeProvider = createMergeProvider(providerConfig.mergeProvider, { model: providerConfig.mergeModel });

    // 4. Collector
    collector = createCollector({
      sessionId,
      onFinalize: (payload) =>
        processSession({
          rawEvents: payload.rawEvents,
          audioBuffer: payload.audioBuffer,
          session: { sessionId, durationMs: payload.durationMs },
          sttProvider,
          mergeProvider,
          artifactsDir: dirs.artifactsDir,
        }),
    });
    await collector.listen(collectorPort);
    log(`collector listening at ${collectorUrl}`);

    // 5. App runner
    runner = await startAppRunner({ appDir: dirs.mirrorDir, port: appPort });

    // 6. Browser
    if (args.open) {
      log(`opening browser at ${runner.url}`);
      if (!openBrowser(runner.url)) log(`could not open a browser — visit ${runner.url} manually`);
    } else {
      log(`open ${runner.url} to start the review`);
    }
    log('waiting for the user to complete the Crit review (Ctrl+C to cancel)...');

    // 7. Cancellation via Ctrl+C
    const onSigint = () => {
      log('received Ctrl+C — cancelling session');
      collector.cancelFromCli('cli_interrupted');
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigint);

    // 8. Block until the session resolves
    const done = await collector.whenDone;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);

    // Give the overlay a chance to poll the terminal state so the widget can
    // show "completed"/"error" before we tear the collector down.
    if (done.outcome === 'completed' || done.outcome === 'error') {
      await collector.waitForFinalPoll(10000);
    }

    const completedAt = new Date().toISOString();
    const sessionMeta = {
      session_id: sessionId,
      status: done.outcome,
      source_dir: sourceDir,
      temp_dir: dirs.mirrorDir,
      app_url: runner.url,
      started_at: done.startedAt || null,
      completed_at: completedAt,
      duration_ms: done.durationMs || 0,
      stt_provider: sttProvider.name,
      stt_model: sttProvider.model,
      merge_provider: mergeProvider.name,
      merge_model: mergeProvider.model,
    };
    try {
      writeJson(dirs.artifactsDir, 'session.json', sessionMeta);
    } catch (e) {
      log('warning: could not write session.json:', e.message);
    }

    if (done.outcome === 'cancelled') {
      await cleanup();
      output(args, { status: 'cancelled', session_id: sessionId, reason: done.reason || 'user_cancelled' });
      return 0;
    }

    if (done.outcome === 'error') {
      await cleanup();
      const err = done.error || new Error('unknown error');
      output(args, {
        status: 'error',
        session_id: sessionId,
        error: { code: err.code || 'PROCESSING_FAILED', message: err.message },
        artifacts: relativizeArtifacts(err.artifacts || {}),
      });
      return 1;
    }

    // completed
    await cleanup();
    output(args, {
      status: 'completed',
      session_id: sessionId,
      started_at: done.startedAt || null,
      completed_at: completedAt,
      duration_ms: done.durationMs || 0,
      final_transcript: done.reviewMarkdown,
      artifacts: relativizeArtifacts({
        ...done.artifacts,
        session: path.join(dirs.artifactsDir, 'session.json'),
      }),
    });
    return 0;
  } catch (e) {
    await cleanup();
    return fail(args, sessionId, e.code || 'INTERNAL_ERROR', e.message);
  }
}

function relativizeArtifacts(artifacts) {
  const out = {};
  const cwd = process.cwd();
  for (const [k, v] of Object.entries(artifacts)) {
    if (typeof v !== 'string') continue;
    const rel = path.relative(cwd, v);
    out[k] = rel.startsWith('..') ? v : rel;
  }
  return out;
}

function output(args, obj) {
  if (args.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    return;
  }
  if (obj.status === 'completed') {
    process.stdout.write(obj.final_transcript + '\n\n');
    process.stdout.write('Artifacts:\n');
    for (const [k, v] of Object.entries(obj.artifacts || {})) {
      process.stdout.write(`  ${k}: ${v}\n`);
    }
  } else if (obj.status === 'cancelled') {
    process.stdout.write(`Crit session ${obj.session_id} was cancelled (${obj.reason}).\n`);
  } else {
    process.stdout.write(`Crit session ${obj.session_id} failed: [${obj.error.code}] ${obj.error.message}\n`);
    if (obj.artifacts && Object.keys(obj.artifacts).length > 0) {
      process.stdout.write('Partial artifacts:\n');
      for (const [k, v] of Object.entries(obj.artifacts)) {
        process.stdout.write(`  ${k}: ${v}\n`);
      }
    }
  }
}

function fail(args, sessionId, code, message) {
  log(`error [${code}]: ${message}`);
  output(args, { status: 'error', session_id: sessionId, error: { code, message } });
  return 1;
}

module.exports = { main };
