#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ENV_FILE_NAMES = ['.env', '.env.local'];

const stripWrappingQuotes = (value) => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
};

const parseEnvFile = (content) => {
  const parsed = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    parsed[key] = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
  }
  return parsed;
};

const loadEnvFromFiles = () => {
  const loaded = {};
  for (const fileName of ENV_FILE_NAMES) {
    const absolutePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(absolutePath)) continue;
    const content = fs.readFileSync(absolutePath, 'utf8');
    Object.assign(loaded, parseEnvFile(content));
  }
  return loaded;
};

const fileEnv = loadEnvFromFiles();
const childEnv = { ...fileEnv, ...process.env };
const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  fileEnv.FIREBASE_PROJECT_ID ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  fileEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  '';
const includeExtensions = process.env.EMULATE_EXTENSIONS === '1';
const includeAppHosting = process.env.EMULATE_APPHOSTING === '1';
const skipFunctionsBuild = process.env.SKIP_FUNCTIONS_BUILD === '1';

const emulators = ['auth', 'functions', 'firestore', 'database', 'storage', 'tasks'];

if (includeExtensions) {
  emulators.push('extensions');
}

if (includeAppHosting) {
  emulators.push('apphosting');
}

const args = ['emulators:start', '--only', emulators.join(','), '--import=./dir'];

if (projectId) {
  args.push('--project', projectId);
  console.log(`[emulators] using Firebase project ${projectId}`);
} else {
  console.log('[emulators] no FIREBASE_PROJECT_ID set; using Firebase default project');
}

if (includeExtensions) {
  console.log('[emulators] extensions emulator enabled (EMULATE_EXTENSIONS=1)');
}

if (includeAppHosting) {
  console.log('[emulators] apphosting emulator enabled (EMULATE_APPHOSTING=1)');
}

if (skipFunctionsBuild) {
  console.log('[emulators] skipping functions codebase build (SKIP_FUNCTIONS_BUILD=1)');
} else {
  console.log('[emulators] building functions codebases before startup...');
  execFileSync('pnpm', ['run', 'build-functions-codebases'], {
    stdio: 'inherit',
    env: childEnv,
    shell: process.platform === 'win32',
  });
}

const child = spawn('firebase', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: childEnv,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
