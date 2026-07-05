/**
 * Mirror the source app into a temp directory using the existing ion compiler
 * pipeline (BabelProcessor), then inject the Crit overlay runtime.
 *
 * The original source app is never modified.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BabelProcessor } = require('../ion-compiler-export/babel-processor');
const { log } = require('./util');

const OVERLAY_SRC = path.resolve(__dirname, '..', 'overlay', 'crit-overlay.js');
const ION_INJECTION_SRC = path.resolve(__dirname, '..', 'ion-compiler-export', 'ion-injection.js');
const CONFIG_PLACEHOLDER = '/*__CRIT_CONFIG__*/ null';

/**
 * Clone + transform the source app into mirrorDir.
 * Throws with code MIRROR_FAILED on fatal errors.
 */
async function mirrorApp({ sourceDir, mirrorDir }) {
  const processor = new BabelProcessor(sourceDir, mirrorDir, {
    pluginOptions: { injectScripts: ['/ion-injection.js', '/crit-overlay.js'] },
  });
  const result = await processor.processDirectory(sourceDir);
  if (result.errors.length > 0) {
    // Per-file transform errors are non-fatal (the file just isn't annotated),
    // but surface them.
    for (const e of result.errors) log('mirror warning:', e);
  }
  if (result.processed === 0 && result.copied === 0) {
    const err = new Error(`Nothing was mirrored from ${sourceDir} — is it an app directory?`);
    err.code = 'MIRROR_FAILED';
    throw err;
  }
  return result;
}

/**
 * Give the mirror its dependencies.
 * - darwin: APFS copy-on-write clone (fast, real directory — Turbopack-safe)
 * - other platforms: symlink
 * - install=true: real package-manager install (copies lockfile first)
 */
function provisionNodeModules({ sourceDir, mirrorDir, install }) {
  const srcModules = path.join(sourceDir, 'node_modules');
  const dstModules = path.join(mirrorDir, 'node_modules');
  if (fs.existsSync(dstModules)) return 'existing';

  if (install) {
    return installDependencies({ sourceDir, mirrorDir });
  }

  if (!fs.existsSync(srcModules)) {
    log('source has no node_modules — running install in the mirror');
    return installDependencies({ sourceDir, mirrorDir });
  }

  if (process.platform === 'darwin') {
    const res = spawnSync('cp', ['-c', '-R', srcModules, dstModules], { stdio: 'ignore' });
    if (res.status === 0) return 'cloned';
    log('APFS clone failed, falling back to symlink');
  }
  fs.symlinkSync(srcModules, dstModules, 'junction');
  return 'symlinked';
}

function installDependencies({ sourceDir, mirrorDir }) {
  const lockfiles = ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];
  let pm = 'npm';
  for (const lf of lockfiles) {
    const src = path.join(sourceDir, lf);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(mirrorDir, lf));
      if (lf.startsWith('bun')) pm = 'bun';
      else if (lf.startsWith('pnpm')) pm = 'pnpm';
      else if (lf.startsWith('yarn')) pm = 'yarn';
      break;
    }
  }
  log(`installing dependencies in mirror with ${pm} (this can take a while)...`);
  const res = spawnSync(pm, ['install'], { cwd: mirrorDir, stdio: ['ignore', 2, 2] });
  if (res.status !== 0) {
    const err = new Error(`Dependency install failed in mirror (${pm} install exited ${res.status})`);
    err.code = 'INSTALL_FAILED';
    throw err;
  }
  return 'installed';
}

/** Symlink .env files so secrets stay in one place (processor already copies .env/.env.local as files). */
function linkEnvFiles({ sourceDir, mirrorDir }) {
  for (const name of fs.readdirSync(sourceDir)) {
    if (!name.startsWith('.env')) continue;
    const dst = path.join(mirrorDir, name);
    try {
      if (!fs.existsSync(dst)) fs.symlinkSync(path.join(sourceDir, name), dst);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Inject the Crit overlay runtime into the mirror:
 * 1. Write public/crit-overlay.js with the session config baked in.
 * 2. Write public/ion-injection.js (source-map decoder).
 * 3. For HTML-entrypoint apps (Vite), add script tags to index.html.
 *    (JSX-body apps like Next get their tags from the babel plugin.)
 */
function injectOverlay({ mirrorDir, config }) {
  const publicDir = path.join(mirrorDir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  const overlaySource = fs.readFileSync(OVERLAY_SRC, 'utf-8');
  if (!overlaySource.includes(CONFIG_PLACEHOLDER)) {
    throw new Error('crit-overlay.js is missing the __CRIT_CONFIG__ placeholder');
  }
  const baked = overlaySource.replace(CONFIG_PLACEHOLDER, JSON.stringify(config));
  fs.writeFileSync(path.join(publicDir, 'crit-overlay.js'), baked, 'utf-8');
  fs.copyFileSync(ION_INJECTION_SRC, path.join(publicDir, 'ion-injection.js'));

  // HTML entrypoints (Vite and friends)
  for (const htmlName of ['index.html', 'app.html']) {
    const htmlPath = path.join(mirrorDir, htmlName);
    if (!fs.existsSync(htmlPath)) continue;
    let html = fs.readFileSync(htmlPath, 'utf-8');
    if (html.includes('/crit-overlay.js')) continue;
    const tags = '<script src="/ion-injection.js" async></script><script src="/crit-overlay.js" async></script>';
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${tags}</body>`);
    } else if (html.includes('</html>')) {
      html = html.replace('</html>', `${tags}</html>`);
    } else {
      html += tags;
    }
    fs.writeFileSync(htmlPath, html, 'utf-8');
  }
}

module.exports = { mirrorApp, provisionNodeModules, linkEnvFiles, injectOverlay, installDependencies };
