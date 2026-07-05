/**
 * Ion Watch Script
 * Watches the entire project for changes and syncs to the target directory.
 * Transforms JSX/TSX files, copies everything else.
 *
 * Usage: ION_TARGET_DIR=../.ion-target node watch.js
 */

const path = require('path');
const fs = require('fs');

// Self-contained deps resolution (see babel-processor.js)
function req(name) {
  const ionModules = path.resolve(__dirname, '..', 'node_modules');
  try {
    return require(path.join(ionModules, name));
  } catch {
    return require(name);
  }
}

const chokidar = req('chokidar');

const { BabelProcessor } = require('./babel-processor.js');

const TARGET_DIR = process.env.ION_TARGET_DIR || '.ion-target';
const processor = new BabelProcessor('.', TARGET_DIR);

let debounceTimer = null;
const DEBOUNCE_MS = 100;

const pendingOperations = new Map();

const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.ion',
  '.ion-target',
  '.next',
  '.nuxt',
  'dist',
  'build',
  '.cache',
  '.turbo',
  '.vercel',
  '.output',
];

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((part) => IGNORE_PATTERNS.includes(part));
}

function scheduleProcess(filePath, operation) {
  if (shouldIgnore(filePath)) {
    return;
  }

  pendingOperations.set(filePath, operation);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const operations = new Map(pendingOperations);
    pendingOperations.clear();

    for (const [file, op] of operations) {
      try {
        if (op === 'delete') {
          await processor.deleteFile(file);
          console.log(`Removed ${file}`);
        } else if (op === 'deleteDir') {
          await processor.deleteDirectory(file);
          console.log(`Removed directory ${file}`);
        } else {
          const result = await processor.processFile(file);
          if (result.error) {
            console.error(`Failed to process ${file}: ${result.error}`);
          } else {
            console.log(`${result.transformed ? 'Transformed' : 'Copied'} ${file}`);
          }
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error.message || error);
      }
    }
  }, DEBOUNCE_MS);
}

async function initialCompilation() {
  console.log('Running initial compilation...');
  console.log(`   Source: ./   Target: ${TARGET_DIR}/`);

  try {
    const result = await processor.processDirectory();
    console.log(`Initial compilation complete. Transformed: ${result.processed}, copied: ${result.copied}`);

    if (result.errors.length > 0) {
      console.log('Errors during compilation:');
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    return true;
  } catch (error) {
    console.error('Initial compilation failed:', error.message || error);
    return false;
  }
}

function startWatcher() {
  console.log('Watching project for changes...');

  const watcher = chokidar.watch('.', {
    ignored: [
      /(^|[\/\\])\../, // Hidden files (but we handle .env specially)
      /node_modules/,
      /\.ion-target/,
      /\.ion(?![\/\\])/,
      /\.git/,
      /\.next/,
      /\.nuxt/,
      /dist(?![\/\\])/,
      /build(?![\/\\])/,
      /\.cache/,
      /\.turbo/,
      /\.vercel/,
      /\.output/,
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 10,
    },
  });

  watcher
    .on('add', (filePath) => {
      if (!shouldIgnore(filePath)) scheduleProcess(filePath, 'add');
    })
    .on('change', (filePath) => {
      if (!shouldIgnore(filePath)) scheduleProcess(filePath, 'change');
    })
    .on('unlink', (filePath) => {
      if (!shouldIgnore(filePath)) scheduleProcess(filePath, 'delete');
    })
    .on('addDir', async (dirPath) => {
      if (!shouldIgnore(dirPath) && dirPath !== '.') {
        const targetPath = path.join(TARGET_DIR, dirPath);
        try {
          await fs.promises.mkdir(targetPath, { recursive: true });
        } catch (error) {
          // Ignore if already exists
        }
      }
    })
    .on('unlinkDir', (dirPath) => {
      if (!shouldIgnore(dirPath)) scheduleProcess(dirPath, 'deleteDir');
    })
    .on('error', (error) => {
      console.error('Watcher error:', error);
    })
    .on('ready', () => {
      console.log('Watcher ready');
    });

  process.on('SIGINT', () => {
    watcher.close().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    watcher.close().then(() => process.exit(0));
  });
}

async function main() {
  const success = await initialCompilation();

  if (!success) {
    console.log('Initial compilation had errors, but continuing to watch...');
  }

  startWatcher();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
