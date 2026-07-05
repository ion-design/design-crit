const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planInstall, runInstall, skillBody, cursorRule } = require('../src/install');
const { parseCliArgs } = require('../src/args');

test('install arg parsing', () => {
  const a = parseCliArgs(['install', '--providers', 'claude,cursor', '--scope', 'project', '--dry-run']);
  assert.equal(a.command, 'install');
  assert.deepEqual(a.providers, ['claude', 'cursor']);
  assert.equal(a.scope, 'project');
  assert.equal(a.dryRun, true);
  assert.throws(() => parseCliArgs(['install', '--scope', 'nope']));
});

test('skill file has Claude frontmatter; cursor rule has mdc frontmatter', () => {
  const skill = skillBody();
  assert.ok(skill.startsWith('---\nname: crit\n'));
  assert.ok(skill.includes('crit review --source . --json'));
  assert.ok(skill.includes('npm install -g design-crit'), 'skill should teach the agent to self-install the CLI');
  const rule = cursorRule();
  assert.ok(rule.startsWith('---\ndescription: Crit'));
  assert.ok(!rule.includes('name: crit'), 'cursor rule should not carry claude frontmatter');
  assert.ok(rule.includes('crit review --source . --json'));
});

test('auto plan only targets existing harness dirs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-install-'));
  fs.mkdirSync(path.join(cwd, '.cursor'));
  const plan = planInstall({ scope: 'project', cwd });
  assert.deepEqual(plan.map((p) => p.provider), ['cursor']);
  assert.equal(plan[0].file, path.join(cwd, '.cursor', 'rules', 'crit.mdc'));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('explicit providers create missing dirs and write files', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-install2-'));
  const installed = runInstall({ providers: ['claude', 'cursor', 'copilot'], scope: 'project', cwd });
  assert.equal(installed.length, 3);
  const claudeSkill = path.join(cwd, '.claude', 'skills', 'crit', 'SKILL.md');
  const cursorMdc = path.join(cwd, '.cursor', 'rules', 'crit.mdc');
  const copilotSkill = path.join(cwd, '.github', 'skills', 'crit', 'SKILL.md');
  for (const f of [claudeSkill, cursorMdc, copilotSkill]) {
    assert.ok(fs.existsSync(f), `missing ${f}`);
  }
  assert.ok(fs.readFileSync(claudeSkill, 'utf-8').includes('name: crit'));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('dry-run writes nothing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-install3-'));
  const installed = runInstall({ providers: ['cursor'], scope: 'project', dryRun: true, cwd });
  assert.equal(installed.length, 1);
  assert.ok(!fs.existsSync(path.join(cwd, '.cursor')));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('unknown provider throws', () => {
  assert.throws(() => planInstall({ providers: ['vscode-clippy'] }), /Unknown provider/);
});
