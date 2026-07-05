/**
 * Shared utilities for the crit CLI.
 * All logging goes to stderr — stdout is reserved for the final result
 * (with --json it must be valid JSON and nothing else).
 */

const net = require('net');
const { spawn } = require('child_process');

function log(...args) {
  process.stderr.write('crit: ' + args.join(' ') + '\n');
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** Find a free port, preferring `preferred` if given. */
async function findFreePort(preferred) {
  if (preferred) {
    if (await isPortFree(preferred)) return preferred;
    log(`port ${preferred} is busy, picking another`);
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Open a URL in the default browser. Best-effort; returns false on failure. */
function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

/** Poll a URL until it responds (any HTTP status) or timeout. */
async function waitForHttp(url, { timeoutMs = 90000, intervalMs = 300, shouldAbort } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort && shouldAbort()) return false;
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      // Any response means the server is up; consume body to free the socket.
      await res.arrayBuffer().catch(() => {});
      return true;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { log, formatClock, findFreePort, isPortFree, openBrowser, waitForHttp, sleep, randomId };
