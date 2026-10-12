#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function selectKitDeployConfig(config, { withoutSearch = false } = {}) {
  const functions = Array.isArray(config.functions) ? config.functions : [config.functions].filter(Boolean);
  const kits = functions.filter(entry => typeof entry.kit === 'string' && entry.kit.length > 0
    && (!withoutSearch || entry.kit !== 'firestore-algolia-search'));
  if (kits.length === 0) throw new Error('firebase.json does not register any function kits.');
  return { ...config, functions: kits };
}

export function selectLegacyDeployConfig(config) {
  const functions = Array.isArray(config.functions) ? config.functions : [config.functions].filter(Boolean);
  const legacyFunctions = functions.filter(entry => !entry.kit);
  if (legacyFunctions.length === 0) throw new Error('firebase.json does not register any legacy function codebases.');
  return { ...config, functions: legacyFunctions };
}

export function createKitDeployConfig({ root = process.cwd(), install = false, legacy = false, withoutSearch = false } = {}) {
  if (legacy && (install || withoutSearch)) throw new Error('--install and --without-search only apply to function kits.');
  const input = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8'));
  const config = legacy ? selectLegacyDeployConfig(input) : selectKitDeployConfig(input, { withoutSearch });
  if (install) {
    for (const entry of config.functions) {
      const source = resolve(root, entry.source);
      const relativeSource = relative(resolve(root, 'function-kits'), source);
      if (relativeSource === '..' || relativeSource.startsWith(`..${sep}`)) {
        throw new Error(`Kit source must be inside function-kits: ${entry.source}`);
      }
      // Keep kit dependencies isolated from the pnpm workspace and enforce their exported npm lockfiles.
      readFileSync(resolve(source, 'package-lock.json'));
      const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`npm ci failed for ${entry.kit} (${result.status}).`);
    }
  }
  const output = resolve(root, legacy ? 'firebase.legacy.json' : 'firebase.kits.json');
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--install', '--legacy', '--without-search'].includes(arg))) {
    throw new Error('Usage: node scripts/create-kit-deploy-config.mjs [--install] [--without-search] | --legacy');
  }
  console.log(`Created ${createKitDeployConfig({ install: args.includes('--install'), legacy: args.includes('--legacy'), withoutSearch: args.includes('--without-search') })}`);
}
