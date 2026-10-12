#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Local data must never activate production search/email kit integrations. */
export function selectDevEmulatorConfig(config) {
  const functions = Array.isArray(config.functions) ? config.functions : [config.functions].filter(Boolean);
  const { extensions: _extensions, ...rest } = config;
  return { ...rest, functions: functions.filter(entry => !entry.kit) };
}

export function writeDevEmulatorConfig({ root = process.cwd() } = {}) {
  const config = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8'));
  const output = resolve(root, 'firebase.dev.json');
  writeFileSync(output, `${JSON.stringify(selectDevEmulatorConfig(config), null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Created ${writeDevEmulatorConfig()}`);
}
