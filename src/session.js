/**
 * Session identity + directory handling for a Crit review session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomId } = require('./util');

function makeSessionId(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `crit_${y}_${m}_${d}_${randomId(6)}`;
}

/**
 * Create the directory layout for a session.
 *
 * outRoot/.crit/reviews/<sessionId>/   — artifacts
 * tempRoot/app/                        — mirrored, transformed app
 */
function createSessionDirs({ sessionId, sourceDir, outDir, tempDir }) {
  const artifactsDir = path.resolve(outDir, sessionId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  let tempRoot;
  let tempCreatedByUs = false;
  if (tempDir) {
    tempRoot = path.resolve(tempDir);
    fs.mkdirSync(tempRoot, { recursive: true });
  } else {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `crit-${sessionId}-`));
    tempCreatedByUs = true;
  }
  const mirrorDir = path.join(tempRoot, 'app');
  fs.mkdirSync(mirrorDir, { recursive: true });

  return { artifactsDir, tempRoot, mirrorDir, tempCreatedByUs, sourceDir: path.resolve(sourceDir) };
}

module.exports = { makeSessionId, createSessionDirs };
