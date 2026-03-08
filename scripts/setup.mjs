#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const envPath = path.join(cwd, '.env');
const templatePath = path.join(cwd, '.env.template');

const parseKeys = (content) =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter((key) => Boolean(key));

if (!fs.existsSync(templatePath)) {
  console.error('[setup] Missing .env.template');
  process.exit(1);
}

const templateContent = fs.readFileSync(templatePath, 'utf8');
const templateKeys = new Set(parseKeys(templateContent));

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(templatePath, envPath);
  console.log('[setup] Created .env from .env.template');
  process.exit(0);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const envKeys = new Set(parseKeys(envContent));
const missingKeys = [...templateKeys].filter((key) => !envKeys.has(key));

if (missingKeys.length === 0) {
  console.log('[setup] .env already contains all template keys');
  process.exit(0);
}

const linesByKey = new Map(
  templateContent
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('=');
    })
    .map((line) => [line.split('=')[0]?.trim(), line])
);

const linesToAppend = missingKeys
  .map((key) => linesByKey.get(key))
  .filter((line) => Boolean(line));

const prefix = envContent.endsWith('\n') ? '' : '\n';
const block = ['# Added by `pnpm run setup:env`', ...linesToAppend, ''].join('\n');

fs.appendFileSync(envPath, `${prefix}${block}`);
console.log(`[setup] Added ${linesToAppend.length} missing key(s) to .env: ${missingKeys.join(', ')}`);
