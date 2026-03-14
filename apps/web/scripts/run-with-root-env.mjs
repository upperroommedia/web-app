#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ENV_FILE_NAMES = ['.env', '.env.local'];
const repoRoot = path.resolve(process.cwd(), '../..');

const stripWrappingQuotes = (value) => {
  if (value.length < 2) {
    return value;
  }

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
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    parsed[key] = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
  }

  return parsed;
};

const loadRootEnv = () => {
  const loaded = {};

  for (const fileName of ENV_FILE_NAMES) {
    const absolutePath = path.join(repoRoot, fileName);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    Object.assign(loaded, parseEnvFile(fs.readFileSync(absolutePath, 'utf8')));
  }

  return loaded;
};

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('[run-with-root-env] Missing command');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: {
    ...loadRootEnv(),
    ...process.env,
  },
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
