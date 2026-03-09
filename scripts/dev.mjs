#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAIL_TO = ['youssef.a.asaad@gmail.com'];
const ENV_FILE_NAMES = ['.env', '.env.local'];

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
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
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

    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
    parsed[key] = value;
  }

  return parsed;
};

const loadEnvFromFiles = () => {
  const loaded = {};
  const loadedFileNames = [];

  for (const fileName of ENV_FILE_NAMES) {
    const absolutePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    Object.assign(loaded, parseEnvFile(content));
    loadedFileNames.push(fileName);
  }

  return { loaded, loadedFileNames };
};

const parseArgs = (argv) => {
  const options = {
    mail: false,
    mailTo: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--mail') {
      options.mail = true;
      continue;
    }

    if (arg.startsWith('--mail=')) {
      const raw = arg.split('=')[1]?.trim().toLowerCase();
      options.mail = raw === 'true' || raw === '1' || raw === 'yes';
      continue;
    }

    if (arg === '--mail-to') {
      options.mailTo = argv[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (arg.startsWith('--mail-to=')) {
      options.mailTo = arg.split('=').slice(1).join('=');
      continue;
    }
  }

  return options;
};

const parseRecipients = (mailTo) => {
  if (!mailTo) {
    return DEFAULT_MAIL_TO;
  }

  const recipients = mailTo
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return recipients.length > 0 ? recipients : DEFAULT_MAIL_TO;
};

const { mail, mailTo } = parseArgs(process.argv.slice(2));
const { loaded: fileEnv, loadedFileNames } = loadEnvFromFiles();
const env = { ...fileEnv, ...process.env };

if (loadedFileNames.length > 0) {
  console.log(`[dev] loaded environment from ${loadedFileNames.join(', ')}`);
}

if (mail) {
  const recipients = parseRecipients(mailTo);
  const recipientsJson = JSON.stringify(recipients);

  env.ROLE_REQUEST_RECIPIENTS = recipientsJson;
  env.RUNTIME_ALERT_RECIPIENTS = recipientsJson;

  if (!env.ADMIN_BASE_URL || env.ADMIN_BASE_URL.trim().length === 0) {
    env.ADMIN_BASE_URL = 'http://localhost:3000';
  }

  console.log(`[dev] --mail enabled; recipients=${recipients.join(', ')}`);
  console.log('[dev] ADMIN_BASE_URL configured for mail templates');
} else {
  console.log('[dev] --mail disabled (default)');
}

const child = spawn('pnpm', ['run', 'dev:core'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
