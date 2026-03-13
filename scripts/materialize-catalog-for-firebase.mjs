#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = process.cwd();
const workspaceConfigPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');

const defaultTargets = [
  'functions-core/package.json',
  'functions-media/package.json',
  'functions-image/package.json',
  'functions-integrations/package.json',
];

const depSections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const parseCatalog = (raw) => {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'catalog:');
  if (start === -1) {
    throw new Error('Missing `catalog:` section in pnpm-workspace.yaml');
  }

  const catalog = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    if (!line.startsWith('  ')) {
      break;
    }

    const match = line.match(/^\s{2}(.+?):\s*(.+)\s*$/);
    if (!match) {
      continue;
    }

    const rawKey = match[1].trim();
    const version = match[2].trim();
    const key =
      (rawKey.startsWith("'") && rawKey.endsWith("'")) || (rawKey.startsWith('"') && rawKey.endsWith('"'))
        ? rawKey.slice(1, -1)
        : rawKey;
    catalog.set(key, version);
  }

  return catalog;
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicitTargets = args.filter((arg) => !arg.startsWith('--'));
const targets = explicitTargets.length > 0 ? explicitTargets : defaultTargets;

const catalog = parseCatalog(fs.readFileSync(workspaceConfigPath, 'utf8'));
const changes = [];

for (const target of targets) {
  const targetPath = path.join(workspaceRoot, target);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target package.json not found: ${target}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  let fileChanged = false;
  const fileChanges = [];

  for (const section of depSections) {
    const deps = packageJson[section];
    if (!deps || typeof deps !== 'object') {
      continue;
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (spec !== 'catalog:') {
        continue;
      }
      const resolved = catalog.get(name);
      if (!resolved) {
        throw new Error(`No catalog version found for ${name} in ${target}`);
      }
      deps[name] = resolved;
      fileChanged = true;
      fileChanges.push({ section, name, resolved });
    }
  }

  if (fileChanged) {
    changes.push({ target, fileChanges });
    if (!dryRun) {
      fs.writeFileSync(targetPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  }
}

if (changes.length === 0) {
  console.log('[catalog-materialize] No catalog references found in target package.json files.');
  process.exit(0);
}

for (const change of changes) {
  console.log(`[catalog-materialize] ${change.target}`);
  for (const item of change.fileChanges) {
    console.log(`  - ${item.section}.${item.name} -> ${item.resolved}`);
  }
}

if (dryRun) {
  console.log('[catalog-materialize] Dry run only, no files were modified.');
}
