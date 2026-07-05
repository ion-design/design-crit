const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWorkspaceRoot, findEnclosingWorkspaceRoot, listWorkspaceApps } = require('../src/workspace');

function makeMonorepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-ws-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'mono', workspaces: ['apps/*', 'packages/*'] })
  );
  const mk = (rel, pkg) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };
  mk('apps/web', { name: 'web', dependencies: { next: '^15.0.0' } });
  mk('apps/admin', { name: 'admin', devDependencies: { vite: '^6.0.0' } });
  mk('packages/ui', { name: '@mono/ui' });
  return root;
}

test('isWorkspaceRoot and enclosing-root detection', () => {
  const root = makeMonorepo();
  assert.equal(isWorkspaceRoot(root), true);
  assert.equal(isWorkspaceRoot(path.join(root, 'apps', 'web')), false);
  assert.equal(findEnclosingWorkspaceRoot(path.join(root, 'apps', 'web')), root);
  assert.equal(findEnclosingWorkspaceRoot(root), null); // excludes self
  fs.rmSync(root, { recursive: true, force: true });
});

test('listWorkspaceApps finds framework apps, skips plain packages', () => {
  const root = makeMonorepo();
  const apps = listWorkspaceApps(root);
  assert.deepEqual(apps.map((a) => a.rel).sort(), ['apps/admin', 'apps/web']);
  assert.deepEqual(apps.map((a) => a.framework).sort(), ['next', 'vite']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pnpm-workspace.yaml is recognized', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-pnpm-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p' }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  fs.mkdirSync(path.join(root, 'apps', 'site'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'apps', 'site', 'package.json'),
    JSON.stringify({ name: 'site', dependencies: { vite: '1' } })
  );
  assert.equal(isWorkspaceRoot(root), true);
  assert.deepEqual(listWorkspaceApps(root).map((a) => a.rel), ['apps/site']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--app-dir arg parses', () => {
  const { parseCliArgs } = require('../src/args');
  const a = parseCliArgs(['review', '--source', '/tmp/mono', '--app-dir', 'apps/web']);
  assert.equal(a.appDir, 'apps/web');
  assert.equal(parseCliArgs(['review']).appDir, null);
});
