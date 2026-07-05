const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProjectEnv, parseEnvFile } = require('../src/env');
const { resolveProviders } = require('../src/args');

test('parseEnvFile handles comments, quotes, export prefix', () => {
  const vars = parseEnvFile([
    '# comment',
    'OPENAI_API_KEY=sk-plain',
    'export ANTHROPIC_API_KEY="sk-quoted"',
    "CRIT_STT_MODEL='whisper-1'",
    'CRIT_MERGE_PROVIDER=openai # inline comment',
    'not a valid line',
    'EMPTY=',
  ].join('\n'));
  assert.equal(vars.OPENAI_API_KEY, 'sk-plain');
  assert.equal(vars.ANTHROPIC_API_KEY, 'sk-quoted');
  assert.equal(vars.CRIT_STT_MODEL, 'whisper-1');
  assert.equal(vars.CRIT_MERGE_PROVIDER, 'openai');
  assert.equal(vars.EMPTY, '');
});

test('loadProjectEnv: whitelisted keys only, calling env wins, .env.local overrides .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-env-'));
  fs.writeFileSync(path.join(dir, '.env'), [
    'OPENAI_API_KEY=sk-from-dotenv',
    'ANTHROPIC_API_KEY=sk-anthropic',
    'CRIT_STT_MODEL=whisper-1',
    'DATABASE_URL=postgres://secret',   // not whitelisted — must not leak
    'SOME_TOKEN=abc',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.env.local'), 'CRIT_STT_MODEL=whisper-large\n');

  const env = { OPENAI_API_KEY: 'sk-from-agent' }; // calling env already has this
  const applied = loadProjectEnv(dir, env);

  assert.equal(env.OPENAI_API_KEY, 'sk-from-agent', 'calling env must win');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-anthropic');
  assert.equal(env.CRIT_STT_MODEL, 'whisper-large', '.env.local overrides .env');
  assert.equal(env.DATABASE_URL, undefined, 'non-whitelisted keys must not be imported');
  assert.equal(env.SOME_TOKEN, undefined);
  assert.deepEqual(applied.sort(), ['ANTHROPIC_API_KEY', 'CRIT_STT_MODEL']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadProjectEnv: missing files are fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-env2-'));
  const env = {};
  assert.deepEqual(loadProjectEnv(dir, env), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveProviders: flag > env > default', () => {
  // defaults with empty env
  let r = resolveProviders({ sttProvider: null, sttModel: null, mergeProvider: null, mergeModel: null }, {});
  assert.equal(r.sttProvider, 'openai');
  assert.equal(r.mergeProvider, 'openai');

  // ANTHROPIC_API_KEY flips the merge default
  r = resolveProviders({ sttProvider: null, sttModel: null, mergeProvider: null, mergeModel: null }, { ANTHROPIC_API_KEY: 'x' });
  assert.equal(r.mergeProvider, 'anthropic');

  // env vars fill in
  r = resolveProviders(
    { sttProvider: null, sttModel: null, mergeProvider: null, mergeModel: null },
    { CRIT_STT_PROVIDER: 'mock', CRIT_STT_MODEL: 'm1', CRIT_MERGE_PROVIDER: 'mock', CRIT_MERGE_MODEL: 'm2' }
  );
  assert.deepEqual(r, { sttProvider: 'mock', sttModel: 'm1', mergeProvider: 'mock', mergeModel: 'm2' });

  // explicit flags beat env
  r = resolveProviders(
    { sttProvider: 'openai', sttModel: 'whisper-1', mergeProvider: 'openai', mergeModel: 'gpt-4o-mini' },
    { CRIT_STT_PROVIDER: 'mock', CRIT_MERGE_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'x' }
  );
  assert.equal(r.sttProvider, 'openai');
  assert.equal(r.mergeProvider, 'openai');
});
