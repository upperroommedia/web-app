#!/usr/bin/env node

import { spawn } from 'node:child_process';

const DEFAULT_MAIL_TO = ['youssef.a.asaad@gmail.com'];

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
const env = { ...process.env };

if (mail) {
  const recipients = parseRecipients(mailTo);
  const recipientsJson = JSON.stringify(recipients);

  env.ROLE_REQUEST_RECIPIENTS = recipientsJson;
  env.RUNTIME_ALERT_RECIPIENTS = recipientsJson;

  if (!env.ADMIN_BASE_URL || env.ADMIN_BASE_URL.trim().length === 0) {
    env.ADMIN_BASE_URL = 'http://localhost:3000';
  }

  console.log(`[dev] --mail enabled; recipients=${recipients.join(', ')}`);
  console.log(`[dev] ADMIN_BASE_URL=${env.ADMIN_BASE_URL}`);
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

