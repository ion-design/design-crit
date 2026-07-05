const test = require('node:test');
const assert = require('node:assert');
const { parseCliArgs } = require('../src/args');

test('defaults', () => {
  const a = parseCliArgs(['review']);
  assert.equal(a.command, 'review');
  assert.equal(a.source, process.cwd());
  assert.equal(a.open, true);
  assert.equal(a.json, false);
  assert.equal(a.keepTemp, false);
  assert.equal(a.mockAi, false);
});

test('review is the default command', () => {
  const a = parseCliArgs([]);
  assert.equal(a.command, 'review');
});

test('all flags parse', () => {
  const a = parseCliArgs([
    'review', '--source', '/tmp/app', '--out', '/tmp/out', '--temp-dir', '/tmp/t',
    '--port', '4321', '--no-open', '--json', '--keep-temp',
    '--stt-provider', 'openai', '--stt-model', 'whisper-1',
    '--merge-provider', 'openai', '--merge-model', 'gpt-4o-mini',
  ]);
  assert.equal(a.source, '/tmp/app');
  assert.equal(a.out, '/tmp/out');
  assert.equal(a.tempDir, '/tmp/t');
  assert.equal(a.port, 4321);
  assert.equal(a.open, false);
  assert.equal(a.json, true);
  assert.equal(a.keepTemp, true);
  assert.equal(a.sttProvider, 'openai');
  assert.equal(a.sttModel, 'whisper-1');
  assert.equal(a.mergeProvider, 'openai');
  assert.equal(a.mergeModel, 'gpt-4o-mini');
});

test('--mock-ai forces mock providers', () => {
  const a = parseCliArgs(['review', '--mock-ai', '--stt-provider', 'openai']);
  assert.equal(a.sttProvider, 'mock');
  assert.equal(a.mergeProvider, 'mock');
  assert.equal(a.mockAi, true);
});

test('--path parses and normalizes', () => {
  assert.equal(parseCliArgs(['review']).openPath, '/');
  assert.equal(parseCliArgs(['review', '--path', '/dashboard']).openPath, '/dashboard');
  assert.equal(parseCliArgs(['review', '--path', 'checkout?step=2']).openPath, '/checkout?step=2');
  assert.throws(() => parseCliArgs(['review', '--path', 'https://evil.com']));
  assert.throws(() => parseCliArgs(['review', '--path', '//evil.com']));
});

test('invalid port throws', () => {
  assert.throws(() => parseCliArgs(['review', '--port', 'abc']));
  assert.throws(() => parseCliArgs(['review', '--port', '99999']));
});

test('unknown command throws', () => {
  assert.throws(() => parseCliArgs(['record']));
});

test('--help wins', () => {
  const a = parseCliArgs(['review', '--help']);
  assert.equal(a.command, 'help');
  assert.ok(a.help.includes('crit review'));
});
