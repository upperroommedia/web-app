#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectDevEmulatorConfig } from './write-dev-emulator-config.mjs';

const localSource = '.firebase/email-kit-source';
const localConfig = '.firebase/email-kit-config';

export function selectMailEmulatorConfig(config) {
  const emailKit = [config.functions].flat().find(entry => entry?.kit === 'firestore-send-email');
  if (!emailKit) throw new Error('firebase.json does not register the firestore-send-email function kit.');
  const devConfig = selectDevEmulatorConfig(config);
  return { ...devConfig, functions: [...devConfig.functions, {
    ...emailKit,
    source: localSource,
    instances: { 'firestore-send-email': localConfig },
  }] };
}

export function writeMailEmulatorConfig({ root = process.cwd() } = {}) {
  const input = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8'));
  const config = selectMailEmulatorConfig(input);
  const emailKit = [input.functions].flat().find(entry => entry?.kit === 'firestore-send-email');
  const originalSource = resolve(root, emailKit.source);
  for (const file of ['package.json', 'lib/index.js', 'node_modules']) {
    if (!existsSync(resolve(originalSource, file))) {
      throw new Error(`Missing built email kit ${file}. Run npm ci and npm run build in ${emailKit.source} first.`);
    }
  }
  const source = resolve(root, localSource);
  const instance = resolve(root, localConfig);
  rmSync(source, { recursive: true, force: true });
  rmSync(instance, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(instance, { recursive: true });
  // Copy only built runtime files; production .env files and secret references stay out.
  cpSync(resolve(originalSource, 'lib'), resolve(source, 'lib'), { recursive: true });
  cpSync(resolve(originalSource, 'package.json'), resolve(source, 'package.json'));
  symlinkSync(resolve(originalSource, 'node_modules'), resolve(source, 'node_modules'), 'junction');
  writeFileSync(resolve(instance, '.env.local'), [
    'TESTING=true', 'LOCATION=us-central1', 'DATABASE=(default)', 'MAIL_COLLECTION=mail',
    'DEFAULT_FROM=dev@localhost', 'AUTH_TYPE=UsernamePassword', '',
  ].join('\n'));
  // Firebase CLI currently reads emulator secrets from source, not kit configDir.
  writeFileSync(resolve(source, '.secret.local'), 'SMTP_PASSWORD=local-emulator-placeholder\n');
  const output = resolve(root, 'firebase.mail.json');
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Created ${writeMailEmulatorConfig()}`);
}
