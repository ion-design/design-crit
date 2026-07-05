/**
 * CLI argument parsing for `crit`.
 */

const { parseArgs } = require('util');

const HELP = `crit — agent-requested app review sessions

Usage:
  crit install [options]     Install the Crit skill into your AI coding agents
  crit review [options]      Run a review session (usually invoked by an agent)

Install options:
  --providers <csv>        Harnesses to install into: claude, cursor, copilot, codex.
                           Default: every harness folder detected.
  --scope <scope>          global | project | auto (default: auto)
  --dry-run                Show what would be installed without writing

Review options:
  --source <path>          Source project directory (default: cwd)
  --path <route>           Page to open for the review, e.g. /dashboard (default: /)
  --out <path>             Artifacts directory (default: <source>/.crit/reviews)
  --temp-dir <path>        Explicit temp dir for the mirrored app (default: OS temp)
  --port <number>          App port (default: 4747, auto-picks if busy — stable so the
                           browser's mic permission persists across sessions)
  --no-open                Do not open the browser automatically
  --json                   Print machine-readable JSON to stdout
  --keep-temp              Keep the temp mirror after completion
  --install                Run a real dependency install in the mirror (default: clone/symlink node_modules)
  --stt-provider <name>    Speech-to-text provider: openai | mock (env: CRIT_STT_PROVIDER)
  --stt-model <name>       Speech-to-text model (env: CRIT_STT_MODEL)
  --merge-provider <name>  Merge provider: anthropic | openai | mock (env: CRIT_MERGE_PROVIDER)
  --merge-model <name>     Merge model (env: CRIT_MERGE_MODEL)
  --mock-ai                Use mock transcription + merge (no API keys needed)
  -h, --help               Show this help
`;

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      path: { type: 'string' },
      out: { type: 'string' },
      'temp-dir': { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'keep-temp': { type: 'boolean', default: false },
      install: { type: 'boolean', default: false },
      'stt-provider': { type: 'string' },
      'stt-model': { type: 'string' },
      'merge-provider': { type: 'string' },
      'merge-model': { type: 'string' },
      'mock-ai': { type: 'boolean', default: false },
      providers: { type: 'string' },
      scope: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] || 'review';
  if (values.help) return { command: 'help', help: HELP };

  if (command === 'install') {
    const scope = values.scope || 'auto';
    if (!['auto', 'global', 'project'].includes(scope)) {
      throw new Error(`Invalid --scope "${scope}". Use: auto, global, or project`);
    }
    return {
      command: 'install',
      providers: values.providers ? values.providers.split(',').map((s) => s.trim()).filter(Boolean) : null,
      scope,
      dryRun: values['dry-run'],
    };
  }

  if (command !== 'review') {
    throw new Error(`Unknown command "${command}". Try: crit install, crit review`);
  }

  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid --port value "${values.port}"`);
    }
  }

  const source = values.source || process.cwd();

  let openPath = values.path || '/';
  if (!openPath.startsWith('/')) openPath = '/' + openPath;
  if (/^\/\/|[\s]/.test(openPath) || openPath.includes('://')) {
    throw new Error(`Invalid --path "${values.path}" — expected an app route like /dashboard`);
  }

  return {
    command: 'review',
    source,
    openPath,
    out: values.out || null, // resolved against source later
    tempDir: values['temp-dir'] || null,
    port: port || null,
    open: !values['no-open'],
    json: values.json,
    keepTemp: values['keep-temp'],
    install: values.install,
    mockAi: values['mock-ai'],
    // Provider flags stay raw here (null = not specified); final resolution
    // happens in resolveProviders() AFTER the project's .env is loaded.
    sttProvider: values['mock-ai'] ? 'mock' : values['stt-provider'] || null,
    sttModel: values['stt-model'] || null,
    mergeProvider: values['mock-ai'] ? 'mock' : values['merge-provider'] || null,
    mergeModel: values['merge-model'] || null,
  };
}

/**
 * Resolve final provider config. Precedence: explicit flag (or --mock-ai) >
 * env var (calling env, topped up from the project's .env) > default.
 */
function resolveProviders(args, env = process.env) {
  return {
    sttProvider: args.sttProvider || env.CRIT_STT_PROVIDER || 'openai',
    sttModel: args.sttModel || env.CRIT_STT_MODEL || null,
    mergeProvider:
      args.mergeProvider || env.CRIT_MERGE_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai'),
    mergeModel: args.mergeModel || env.CRIT_MERGE_MODEL || null,
  };
}

module.exports = { parseCliArgs, resolveProviders, HELP };
