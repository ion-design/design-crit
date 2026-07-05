/**
 * `crit install` — install the Crit skill into AI coding harnesses,
 * impeccable-style: detect harness folders, drop the skill file into each.
 *
 * Supported harnesses:
 *   claude   Claude Code        ~/.claude/skills/crit/SKILL.md   (global)
 *                               ./.claude/skills/crit/SKILL.md   (project)
 *   cursor   Cursor             ./.cursor/rules/crit.mdc         (project)
 *   copilot  GitHub Copilot     ./.github/skills/crit/SKILL.md   (project)
 *   codex    Codex CLI/agents   ~/.agents/skills/crit/SKILL.md   (global)
 *                               ./.agents/skills/crit/SKILL.md   (project)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_SRC = path.resolve(__dirname, '..', 'skill', 'SKILL.md');

function skillBody() {
  return fs.readFileSync(SKILL_SRC, 'utf-8');
}

/** The skill body without its Claude-style frontmatter (for other formats). */
function skillBodyWithoutFrontmatter() {
  const content = skillBody();
  const m = content.match(/^---\n[\s\S]*?\n---\n/);
  return m ? content.slice(m[0].length).trimStart() : content;
}

function cursorRule() {
  return [
    '---',
    'description: Crit — request a narrated design review of the running app from the user. Use when you want human design feedback on UI, or the user says "crit" / "get my feedback" / "review this with me".',
    'alwaysApply: false',
    '---',
    '',
    skillBodyWithoutFrontmatter(),
  ].join('\n');
}

const HARNESSES = {
  claude: {
    label: 'Claude Code',
    scopes: ['global', 'project'],
    detectDir: (scope, cwd) => (scope === 'global' ? path.join(os.homedir(), '.claude') : path.join(cwd, '.claude')),
    targetFile: (base) => path.join(base, 'skills', 'crit', 'SKILL.md'),
    content: skillBody,
  },
  cursor: {
    label: 'Cursor',
    scopes: ['project'],
    detectDir: (_scope, cwd) => path.join(cwd, '.cursor'),
    targetFile: (base) => path.join(base, 'rules', 'crit.mdc'),
    content: cursorRule,
  },
  copilot: {
    label: 'GitHub Copilot',
    scopes: ['project'],
    detectDir: (_scope, cwd) => path.join(cwd, '.github'),
    targetFile: (base) => path.join(base, 'skills', 'crit', 'SKILL.md'),
    content: skillBody,
  },
  codex: {
    label: 'Codex CLI',
    scopes: ['global', 'project'],
    detectDir: (scope, cwd) => (scope === 'global' ? path.join(os.homedir(), '.agents') : path.join(cwd, '.agents')),
    targetFile: (base) => path.join(base, 'skills', 'crit', 'SKILL.md'),
    content: skillBody,
  },
};

/**
 * Figure out which (provider, scope) targets to install to.
 * - explicit providers: install to those (creating dirs), using --scope or the
 *   provider's most natural scope.
 * - auto: install wherever a harness folder already exists.
 */
function planInstall({ providers = null, scope = 'auto', cwd = process.cwd(), home = os.homedir() } = {}) {
  const plan = [];
  const names = providers && providers.length ? providers : Object.keys(HARNESSES);
  for (const name of names) {
    const h = HARNESSES[name];
    if (!h) throw new Error(`Unknown provider "${name}". Supported: ${Object.keys(HARNESSES).join(', ')}`);
    const scopes = scope === 'auto' ? h.scopes : h.scopes.filter((s) => s === scope);
    for (const s of scopes) {
      const base = h.detectDir(s, cwd, home);
      const exists = fs.existsSync(base);
      // auto mode only touches harnesses that are actually present;
      // explicitly requested providers get their dirs created.
      if (!exists && !(providers && providers.length)) continue;
      plan.push({ provider: name, label: h.label, scope: s, base, file: h.targetFile(base), content: h.content });
      if (scope === 'auto' && s === 'global' && providers == null) {
        // if installed globally in auto mode, skip the project copy of the same provider
        // (global covers every project).
        break;
      }
    }
  }
  return plan;
}

function runInstall({ providers, scope, dryRun, cwd } = {}) {
  const plan = planInstall({ providers, scope, cwd });
  const installed = [];
  for (const step of plan) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(step.file), { recursive: true });
      fs.writeFileSync(step.file, step.content(), 'utf-8');
    }
    installed.push(step);
  }
  return installed;
}

module.exports = { planInstall, runInstall, HARNESSES, skillBody, cursorRule };
