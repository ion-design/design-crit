const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSessionId, createSessionDirs } = require('../src/session');

test('session id format', () => {
  const id = makeSessionId(new Date('2026-07-04T18:22:10Z'));
  assert.match(id, /^crit_2026_07_04_[a-z0-9]{6}$/);
  assert.notEqual(makeSessionId(), makeSessionId());
});

test('createSessionDirs builds artifacts + mirror dirs', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-sess-test-'));
  const sessionId = makeSessionId();
  const dirs = createSessionDirs({
    sessionId,
    sourceDir: base,
    outDir: path.join(base, '.crit', 'reviews'),
    tempDir: null,
  });
  assert.ok(fs.existsSync(dirs.artifactsDir));
  assert.ok(dirs.artifactsDir.endsWith(sessionId));
  assert.ok(fs.existsSync(dirs.mirrorDir));
  assert.equal(path.basename(dirs.mirrorDir), 'app');
  assert.equal(dirs.tempCreatedByUs, true);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(dirs.tempRoot, { recursive: true, force: true });
});

test('createSessionDirs respects explicit temp dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-sess-test2-'));
  const dirs = createSessionDirs({
    sessionId: 'crit_x',
    sourceDir: base,
    outDir: path.join(base, 'out'),
    tempDir: path.join(base, 'mytemp'),
  });
  assert.equal(dirs.tempRoot, path.join(base, 'mytemp'));
  assert.equal(dirs.tempCreatedByUs, false);
  fs.rmSync(base, { recursive: true, force: true });
});
