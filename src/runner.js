/**
 * App runner — detects the framework in the mirrored app and starts its dev server.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log, waitForHttp } = require('./util');

function detectFramework(appDir) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
  } catch {
    return { kind: 'unknown', pkg: null };
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return { kind: 'next', pkg };
  if (deps.vite) return { kind: 'vite', pkg };
  if (pkg.scripts && pkg.scripts.dev) return { kind: 'script', pkg };
  return { kind: 'unknown', pkg };
}

function commandFor(kind, appDir, port) {
  const bin = (name) => path.join(appDir, 'node_modules', '.bin', name);
  switch (kind) {
    case 'next':
      return { cmd: bin('next'), args: ['dev', '-p', String(port)] };
    case 'vite':
      return { cmd: bin('vite'), args: ['--port', String(port), '--strictPort'] };
    case 'script':
      return { cmd: 'npm', args: ['run', 'dev'] };
    default:
      return null;
  }
}

/**
 * Start the dev server for the mirrored app. Resolves once HTTP responds.
 * Returns { proc, url, stop() }.
 */
async function startAppRunner({ appDir, port, timeoutMs = 120000 }) {
  const { kind } = detectFramework(appDir);
  const command = commandFor(kind, appDir, port);
  if (!command) {
    const err = new Error(`Could not determine how to run the app in ${appDir} (no next/vite dep, no "dev" script)`);
    err.code = 'APP_START_FAILED';
    throw err;
  }
  log(`starting app runner (${kind}): ${path.basename(command.cmd)} ${command.args.join(' ')}`);

  const outputTail = [];
  const proc = spawn(command.cmd, command.args, {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let exited = false;
  let exitInfo = null;
  proc.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  const capture = (chunk) => {
    const text = chunk.toString();
    outputTail.push(text);
    while (outputTail.length > 60) outputTail.shift();
  };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);

  const url = `http://localhost:${port}`;
  const up = await waitForHttp(url, { timeoutMs, shouldAbort: () => exited });
  if (!up) {
    stopProcess(proc);
    const err = new Error(
      exited
        ? `App runner exited early (code ${exitInfo?.code}, signal ${exitInfo?.signal}).\n--- output ---\n${outputTail.join('')}`
        : `App did not respond at ${url} within ${timeoutMs / 1000}s.\n--- output ---\n${outputTail.join('')}`
    );
    err.code = 'APP_START_FAILED';
    throw err;
  }
  log(`app running at ${url}`);
  return {
    proc,
    url,
    kind,
    stop: () => stopProcess(proc),
    getOutputTail: () => outputTail.join(''),
  };
}

function stopProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform !== 'win32' && proc.pid) {
      process.kill(-proc.pid, 'SIGTERM'); // whole process group
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (proc.exitCode === null) {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

module.exports = { detectFramework, commandFor, startAppRunner, stopProcess };
