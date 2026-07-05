/**
 * Project .env loading for crit's own providers.
 *
 * Precedence: the calling process env (the agent's shell) always wins;
 * project .env files only fill in what's missing. Only keys crit actually
 * uses are read — we never import the project's whole environment.
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_KEY = /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|CRIT_[A-Z0-9_]+)$/;

/** Minimal dotenv parser: KEY=value lines, # comments, optional quotes. */
function parseEnvFile(content) {
  const out = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // strip trailing inline comment on unquoted values
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Load whitelisted keys from <sourceDir>/.env and .env.local into `env`
 * (later files override earlier ones), without overwriting anything already
 * set. Returns the list of keys that were applied.
 */
function loadProjectEnv(sourceDir, env = process.env) {
  const loaded = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(sourceDir, name);
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const vars = parseEnvFile(content);
    for (const [k, v] of Object.entries(vars)) {
      if (ALLOWED_KEY.test(k) && v) loaded[k] = v;
    }
  }
  const applied = [];
  for (const [k, v] of Object.entries(loaded)) {
    if (env[k] === undefined || env[k] === '') {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}

module.exports = { loadProjectEnv, parseEnvFile };
