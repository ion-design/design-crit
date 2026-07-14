/**
 * Ion Babel Processor
 * Clones a project tree into a target directory, transforming .jsx/.tsx files
 * through the ion babel plugin (source annotations + script injection) and
 * copying everything else byte-for-byte. The source tree is never modified.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const { transformAsync } = require('@babel/core');
const presetTypescript = require('@babel/preset-typescript');
const babelPluginSyntaxJsx = require('@babel/plugin-syntax-jsx');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);

const ionBabelPlugin = require('./ion-babel-plugin.js');

class BabelProcessor {
  constructor(rootDir, targetDir, options = {}) {
    this.rootDir = rootDir;
    this.targetDir = targetDir;
    // Options forwarded to ion-babel-plugin (e.g. { injectScripts: [...] }).
    this.pluginOptions = options.pluginOptions || {};
    this.ignorePatterns = [
      'node_modules',
      '.git',
      '.crit',
      '.next',
      '.nuxt',
      'dist',
      'build',
      '.cache',
      '.turbo',
      '.vercel',
      '.output',
      ...(options.extraIgnorePatterns || []),
    ];
  }

  shouldIgnore(name, relativePath) {
    if (name.startsWith('.') && name !== '.env' && name !== '.env.local') {
      return this.ignorePatterns.some((p) => name === p);
    }
    return this.ignorePatterns.some((p) => name === p || relativePath.startsWith(p + path.sep));
  }

  shouldTransform(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.jsx' || ext === '.tsx';
  }

  async processFile(sourceFilePath) {
    try {
      const ext = path.extname(sourceFilePath).toLowerCase();
      const relativePath = path.relative(this.rootDir, sourceFilePath);
      const targetFilePath = path.join(this.targetDir, relativePath);

      await mkdir(path.dirname(targetFilePath), { recursive: true });

      if (!this.shouldTransform(sourceFilePath)) {
        await copyFile(sourceFilePath, targetFilePath);
        return { transformed: false };
      }

      const code = await readFile(sourceFilePath, 'utf-8');

      const presets = [];
      if (ext === '.tsx') {
        // isTSX + allExtensions are required so the TS parser allows JSX —
        // with ignoreExtensions alone, `<html>` parses as a type assertion.
        presets.push([presetTypescript, { ignoreExtensions: true, allExtensions: true, isTSX: true }]);
      }

      const result = await transformAsync(code, {
        filename: sourceFilePath,
        presets,
        plugins: [babelPluginSyntaxJsx, [ionBabelPlugin, this.pluginOptions]],
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        retainLines: true,
      });

      if (!result || !result.code) {
        throw new Error(`No code generated from ${sourceFilePath}`);
      }

      await writeFile(targetFilePath, result.code, 'utf-8');
      return { transformed: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { transformed: false, error: errorMessage };
    }
  }

  async processDirectory(dirPath) {
    if (!dirPath) {
      dirPath = this.rootDir;
    }

    const result = {
      processed: 0,
      copied: 0,
      errors: [],
    };

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(this.rootDir, fullPath);

        if (this.shouldIgnore(entry.name, relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await mkdir(path.join(this.targetDir, relativePath), { recursive: true });

          const subResult = await this.processDirectory(fullPath);
          result.processed += subResult.processed;
          result.copied += subResult.copied;
          result.errors.push(...subResult.errors);
        } else if (entry.isFile()) {
          const processResult = await this.processFile(fullPath);

          if (processResult.error) {
            result.errors.push(`${fullPath}: ${processResult.error}`);
          } else if (processResult.transformed) {
            result.processed++;
          } else {
            result.copied++;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(`Directory ${dirPath}: ${errorMessage}`);
    }

    return result;
  }
}

module.exports = { BabelProcessor };
