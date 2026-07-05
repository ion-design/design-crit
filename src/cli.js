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
const { loadProjectEnv, loadEnvFileVars } = require('./env');
const { makeSessionId, createSessionDirs } = require('./session');
const { mirrorApp, provisionNodeModules, linkEnvFiles, injectOverlay } = require('./mirror');
const { startAppRunner } = require('./runner');
const { createReviewProxy } = require('./proxy');
const { isWorkspaceRoot, findEnclosingWorkspaceRoot, listWorkspaceApps } = require('./workspace');
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
  if (args.command === 'install') {
    return runInstallCommand(args);
  }
  return runReview(args);
}

function runInstallCommand(args) {
  const { runInstall } = require('./install');
  let installed;
  try {
    installed = runInstall({ providers: args.providers, scope: args.scope, dryRun: args.dryRun });
  } catch (e) {
    process.stderr.write(`crit: ${e.message}\n`);
    return 1;
  }
  if (installed.length === 0) {
    process.stdout.write(
      'No agent harness folders detected (looked for ~/.claude, ~/.agents, ./.claude, ./.cursor, ./.github, ./.agents).\n' +
        'Pick one explicitly, e.g.:  crit install --providers claude --scope global\n'
    );
    return 1;
  }
  const verb = args.dryRun ? 'Would install' : 'Installed';
  process.stdout.write(`${verb} the Crit skill:\n\n`);
  for (const step of installed) {
    process.stdout.write(`  ${step.label.padEnd(16)} ${step.scope.padEnd(8)} ${step.file}\n`);
  }
  process.stdout.write(
    '\nNext: reload your agent, then ask it for a review — try "give me a crit" (Claude Code: /crit).\n' +
      'The skill installs the design-crit CLI on first use if it is missing.\n'
  );
  return 0;
}

async function runReview(args) {
  const sessionId = makeSessionId();
  const sourceDir = path.resolve(args.source);
  const outDir = args.out ? path.resolve(args.out) : path.join(sourceDir, '.crit', 'reviews');

  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    return fail(args, sessionId, 'MIRROR_FAILED', `No package.json found in ${sourceDir} — is it an app directory?`);
  }

  // Monorepo resolution: mirror the whole workspace (so workspace packages
  // and hoisted node_modules resolve) but run the dev server from the app
  // package. Three ways in:
  //   --source <root> --app-dir apps/web    explicit
  //   --source <root-with-workspaces>       auto-pick if exactly one app
  //   --source <app-inside-workspace>       enclosing root auto-detected
  let mirrorSourceDir = sourceDir;
  let appDirRel = '.';
  if (args.appDir) {
    appDirRel = args.appDir;
    if (!fs.existsSync(path.join(sourceDir, appDirRel, 'package.json'))) {
      return fail(args, sessionId, 'APP_DIR_INVALID', `--app-dir "${appDirRel}" has no package.json under ${sourceDir}`);
    }
  } else if (isWorkspaceRoot(sourceDir)) {
    const apps = listWorkspaceApps(sourceDir);
    if (apps.length === 1) {
      appDirRel = apps[0].rel;
      log(`monorepo: auto-selected app package ${appDirRel} (${apps[0].name})`);
    } else if (apps.length > 1) {
      return fail(
        args,
        sessionId,
        'MONOREPO_APP_AMBIGUOUS',
        `${sourceDir} is a workspace root with multiple app packages. Rerun with --app-dir <one of: ${apps
          .map((a) => a.rel)
          .join(', ')}>`
      );
    }
  } else {
    const wsRoot = findEnclosingWorkspaceRoot(sourceDir);
    if (wsRoot) {
      mirrorSourceDir = wsRoot;
      appDirRel = path.relative(wsRoot, sourceDir);
      log(`monorepo: mirroring workspace root ${wsRoot}, app package ${appDirRel}`);
    }
  }

  // Top up crit's env (API keys, CRIT_* settings) from the project's .env
  // files (app package first, then workspace root) — the calling process env
  // always wins. Never log the values.
  const appliedEnv = [
    ...loadProjectEnv(path.join(mirrorSourceDir, appDirRel)),
    ...(mirrorSourceDir !== sourceDir || appDirRel !== '.' ? loadProjectEnv(mirrorSourceDir) : []),
  ];
  if (appliedEnv.length > 0) log(`loaded from project .env: ${appliedEnv.join(', ')}`);
  const providerConfig = resolveProviders(args);

  let dirs;
  try {
    dirs = createSessionDirs({ sessionId, sourceDir: mirrorSourceDir, outDir, tempDir: args.tempDir });
  } catch (e) {
    return fail(args, sessionId, 'TEMP_DIR_FAILED', `Could not create session directories: ${e.message}`);
  }
  const appMirrorDir = path.join(dirs.mirrorDir, appDirRel);
  log(`session ${sessionId}`);
  log(`mirroring ${mirrorSourceDir} → ${dirs.mirrorDir}`);

  let runner = null;
  let collector = null;
  let proxy = null;
  const cleanup = async () => {
    try { if (runner) runner.stop(); } catch { /* ignore */ }
    try { if (proxy) await proxy.close(); } catch { /* ignore */ }
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
    // 1. Mirror the app (or whole workspace) through the ion compiler pipeline
    const mirrorResult = await mirrorApp({ sourceDir: mirrorSourceDir, mirrorDir: dirs.mirrorDir });
    log(`mirrored: ${mirrorResult.processed} transformed, ${mirrorResult.copied} copied`);
    const nmMode = provisionNodeModules({ sourceDir: mirrorSourceDir, mirrorDir: dirs.mirrorDir, install: args.install });
    log(`node_modules: ${nmMode}`);
    linkEnvFiles({ sourceDir: mirrorSourceDir, mirrorDir: dirs.mirrorDir });
    if (appDirRel !== '.') {
      linkEnvFiles({ sourceDir: path.join(mirrorSourceDir, appDirRel), mirrorDir: appMirrorDir });
    }

    // 2. Ports + overlay config
    // The browser talks to a review proxy on a STABLE port: permissions are
    // scoped per origin incl. port, so a stable port means the user's one-time
    // mic "Allow" persists across sessions. The proxy also strips headers that
    // would break the review (Permissions-Policy microphone=(), CSP). The app
    // dev server itself runs on an internal random port behind it.
    const collectorPort = await findFreePort();
    const publicPort = await findFreePort(args.port || 4747);
    const appPort = await findFreePort();
    const collectorUrl = `http://127.0.0.1:${collectorPort}`;
    injectOverlay({
      mirrorDir: appMirrorDir,
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

    // 5. App runner (internal port) + review proxy (public, stable port)
    // In a monorepo, hand the app the workspace-root .env its own dev script
    // would normally inject (e.g. `dotenv -e ../../.env -- next dev`).
    const extraEnv = appDirRel !== '.' ? loadEnvFileVars(mirrorSourceDir) : {};
    runner = await startAppRunner({ appDir: appMirrorDir, port: appPort, extraEnv });
    proxy = createReviewProxy({ targetPort: appPort });
    await proxy.listen(publicPort);
    const publicUrl = `http://localhost:${publicPort}`;
    log(`review proxy at ${publicUrl} → app :${appPort} (permissions/CSP headers stripped)`);

    // 6. Browser — land the reviewer on the page the agent asked for
    const reviewUrl = publicUrl + (args.openPath && args.openPath !== '/' ? args.openPath : '');
    if (args.open) {
      log(`opening browser at ${reviewUrl}`);
      if (!openBrowser(reviewUrl)) log(`could not open a browser — visit ${reviewUrl} manually`);
    } else {
      log(`open ${reviewUrl} to start the review`);
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
      workspace_root: mirrorSourceDir !== sourceDir ? mirrorSourceDir : undefined,
      app_dir: appDirRel !== '.' ? appDirRel : undefined,
      temp_dir: dirs.mirrorDir,
      app_url: `http://localhost:${publicPort}`,
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
