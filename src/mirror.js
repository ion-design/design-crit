/**
 * Mirror the source app into a temp directory using the existing ion compiler
 * pipeline (BabelProcessor), then inject the Crit overlay runtime.
 *
 * The original source app is never modified.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BabelProcessor } = require('../ion-compiler/babel-processor');
const { log } = require('./util');

const OVERLAY_SRC = path.resolve(__dirname, '..', 'overlay', 'crit-overlay.js');
const CONFIG_PLACEHOLDER = '/*__CRIT_CONFIG__*/ null';

/**
 * Clone + transform the source app into mirrorDir.
 * Throws with code MIRROR_FAILED on fatal errors.
 */
async function mirrorApp({ sourceDir, mirrorDir }) {
  const processor = new BabelProcessor(sourceDir, mirrorDir, {
    pluginOptions: { injectScripts: ['/crit-overlay.js'] },
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
 *
 * Workspaces: every node_modules dir near the top of the tree (root plus
 * nested ones in workspace packages, e.g. apps/web/node_modules) is
 * provisioned at the same relative path, so hoisted deps and per-package
 * binaries both resolve in the mirror.
 */
function provisionNodeModules({ sourceDir, mirrorDir, install }) {
  if (fs.existsSync(path.join(mirrorDir, 'node_modules'))) return 'existing';

  if (install) {
    return installDependencies({ sourceDir, mirrorDir });
  }

  const moduleDirs = findNodeModulesDirs(sourceDir, 3);
  if (moduleDirs.length === 0) {
    log('source has no node_modules — running install in the mirror');
    return installDependencies({ sourceDir, mirrorDir });
  }

  let mode = null;
  for (const src of moduleDirs) {
    const rel = path.relative(sourceDir, src);
    const dst = path.join(mirrorDir, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (process.platform === 'darwin') {
      const res = spawnSync('cp', ['-c', '-R', src, dst], { stdio: 'ignore' });
      if (res.status === 0) {
        mode = mode || 'cloned';
        continue;
      }
      log(`APFS clone failed for ${rel}, falling back to symlink`);
    }
    fs.symlinkSync(src, dst, 'junction');
    mode = mode || 'symlinked';
  }
  return `${mode || 'existing'} (${moduleDirs.length} dir${moduleDirs.length === 1 ? '' : 's'})`;
}

/** Find node_modules dirs up to `maxDepth` levels down, without descending into them. */
function findNodeModulesDirs(rootDir, maxDepth) {
  const found = [];
  const skip = new Set(['.git', '.next', '.turbo', 'dist', 'build', '.cache', '.vercel', '.output']);
  (function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === 'node_modules') {
        found.push(path.join(dir, e.name));
        continue; // never descend into node_modules
      }
      if (skip.has(e.name) || e.name.startsWith('.')) continue;
      if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1);
    }
  })(rootDir, 1);
  return found;
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
 * 2. For HTML-entrypoint apps (Vite), add the script tag to index.html.
 *    (JSX-body apps like Next get their tag from the babel plugin.)
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

  // HTML entrypoints (Vite and friends)
  for (const htmlName of ['index.html', 'app.html']) {
    const htmlPath = path.join(mirrorDir, htmlName);
    if (!fs.existsSync(htmlPath)) continue;
    let html = fs.readFileSync(htmlPath, 'utf-8');
    if (html.includes('/crit-overlay.js')) continue;
    const tags = '<script src="/crit-overlay.js" async></script>';
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
