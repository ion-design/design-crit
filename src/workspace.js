/**
 * Monorepo/workspace detection.
 *
 * Crit must mirror the whole workspace (so workspace packages and hoisted
 * node_modules resolve) while running the dev server from the app package.
 */

const fs = require('fs');
const path = require('path');

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function isWorkspaceRoot(dir) {
  const pkg = readPkg(dir);
  if (pkg && pkg.workspaces) return true;
  return fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
}

/** Walk up from startDir looking for an enclosing workspace root (excluding startDir itself). */
function findEnclosingWorkspaceRoot(startDir) {
  let dir = path.dirname(path.resolve(startDir));
  let prev = null;
  while (dir !== prev) {
    if (isWorkspaceRoot(dir)) return dir;
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

function workspaceGlobs(rootDir) {
  const pkg = readPkg(rootDir);
  let globs = [];
  if (pkg && pkg.workspaces) {
    globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
  }
  const pnpmWs = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWs)) {
    // minimal YAML: lines like `  - "apps/*"`
    const lines = fs.readFileSync(pnpmWs, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/);
      if (m) globs.push(m[1]);
    }
  }
  return globs;
}

/**
 * Expand simple workspace globs ("apps/*", "packages/foo") into package dirs,
 * and report which look like runnable apps (next/vite dep, or a dev script).
 */
function listWorkspacePackages(rootDir) {
  const results = [];
  for (const glob of workspaceGlobs(rootDir)) {
    const clean = glob.replace(/\/$/, '');
    if (clean.includes('*')) {
      const base = path.join(rootDir, clean.split('*')[0]);
      let entries = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const e of entries) {
        const dir = path.join(base, e.name);
        const pkg = readPkg(dir);
        if (pkg) results.push(describePackage(rootDir, dir, pkg));
      }
    } else {
      const dir = path.join(rootDir, clean);
      const pkg = readPkg(dir);
      if (pkg) results.push(describePackage(rootDir, dir, pkg));
    }
  }
  return results;
}

function describePackage(rootDir, dir, pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let framework = null;
  if (deps.next) framework = 'next';
  else if (deps.vite) framework = 'vite';
  else if (pkg.scripts && pkg.scripts.dev) framework = 'script';
  return { dir, rel: path.relative(rootDir, dir), name: pkg.name || path.basename(dir), framework };
}

/** Packages that look like runnable web apps (next/vite preferred over bare dev scripts). */
function listWorkspaceApps(rootDir) {
  const pkgs = listWorkspacePackages(rootDir);
  const framed = pkgs.filter((p) => p.framework === 'next' || p.framework === 'vite');
  return framed.length > 0 ? framed : pkgs.filter((p) => p.framework === 'script');
}

module.exports = { isWorkspaceRoot, findEnclosingWorkspaceRoot, listWorkspacePackages, listWorkspaceApps };
