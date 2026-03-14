#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const ROOT = process.cwd();
const WATCH_TARGETS = [
  'functions/src',
  'functions-core/src',
  'functions-media/src',
  'functions-image/src',
  'functions-integrations/src',
  'firebase',
  'shared',
  'types',
  'constants',
  'context',
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const IGNORED_SEGMENTS = new Set(['node_modules', 'lib', '.git', '.turbo']);
const BUILD_COMMAND = ['run', 'build-functions-codebases'];
const BUILD_DEBOUNCE_MS = 250;

const watchers = [];
let buildProcess = null;
let queuedBuildReason = null;
let debounceTimer = null;
let shuttingDown = false;

const prefixOutput = (stream, prefix) => {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    console.log(`${prefix}${line}`);
  });
  return rl;
};

const shouldIgnorePath = (absolutePath) => {
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath.startsWith('..')) {
    return true;
  }

  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return true;
  }

  const extension = path.extname(relativePath);
  return extension && !SOURCE_EXTENSIONS.has(extension);
};

const buildFunctions = (reason) => {
  if (shuttingDown) {
    return;
  }

  if (buildProcess) {
    queuedBuildReason = reason;
    return;
  }

  console.log(`[functions-watch] rebuilding functions (${reason})`);
  buildProcess = spawn('pnpm', BUILD_COMMAND, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const stdout = prefixOutput(buildProcess.stdout, '[functions-watch] ');
  const stderr = prefixOutput(buildProcess.stderr, '[functions-watch] ');

  buildProcess.on('exit', (code, signal) => {
    stdout.close();
    stderr.close();

    if (signal) {
      console.log(`[functions-watch] build exited due to signal ${signal}`);
    } else if (code === 0) {
      console.log('[functions-watch] rebuild complete');
    } else {
      console.log(`[functions-watch] rebuild failed with exit code ${code}`);
    }

    buildProcess = null;

    if (queuedBuildReason) {
      const nextReason = queuedBuildReason;
      queuedBuildReason = null;
      buildFunctions(nextReason);
    }
  });
};

const scheduleBuild = (reason) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    buildFunctions(reason);
  }, BUILD_DEBOUNCE_MS);
};

const watchDirectory = (absoluteDir) => {
  if (!fs.existsSync(absoluteDir)) {
    return;
  }

  const watcher = fs.watch(absoluteDir, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      scheduleBuild(path.relative(ROOT, absoluteDir));
      return;
    }

    const changedPath = path.join(absoluteDir, fileName.toString());
    if (shouldIgnorePath(changedPath)) {
      return;
    }

    scheduleBuild(path.relative(ROOT, changedPath));
  });

  watchers.push(watcher);
};

const shutdown = (signal) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  if (buildProcess) {
    buildProcess.kill(signal);
  }

  process.exit(0);
};

for (const relativeDir of WATCH_TARGETS) {
  watchDirectory(path.join(ROOT, relativeDir));
}

console.log('[functions-watch] watching function sources for changes');

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
