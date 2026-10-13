#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = process.cwd();
const workspaceConfigPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');

export const defaultTargets = [
  'functions-core/package.json',
  'functions-media/package.json',
  'functions-image/package.json',
  'functions-integrations/package.json',
];

const depSections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export const parseCatalog = (raw) => {
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

function flatWorkspaceSection(workspace, section) {
  const lines = workspace.split(/\r?\n/),
    start = lines.findIndex((line) => line.trim() === `${section}:`);
  if (start < 0) return {};
  const result = {};
  const unquote = (text) =>
    (text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))
      ? text.slice(1, -1)
      : text;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(' ')) break;
    const match = line.match(/^ {2}([^ ].*?):\s+(.+)$/);
    if (!match) throw new Error(`Unsupported nested ${section}; review an explicit npm equivalent`);
    const key = unquote(match[1].trim()),
      value = unquote(match[2].trim());
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate ${section} key`);
    result[key] = value;
  }
  return result;
}
export function npmWorkspaceOverrides(workspace) {
  const overrides = flatWorkspaceSection(workspace, 'overrides');
  for (const [name, version] of Object.entries(overrides)) {
    if (
      !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)
    )
      throw new Error(`Unsupported pnpm override ${name}; review an explicit npm equivalent`);
  }
  return overrides;
}
export function validateNpmDeploymentLock(manifest, lock, workspace) {
  if (
    lock.lockfileVersion !== 3 ||
    lock.name !== manifest.name ||
    !lock.packages?.[''] ||
    lock.packages[''].name !== manifest.name
  )
    throw new Error('Missing valid npm v3 deployment lock/root package identity');
  const root = lock.packages[''];
  const equal = (a, b) =>
    JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  for (const section of [...depSections, 'engines'])
    if (!equal(root[section], manifest[section]))
      throw new Error(`Npm lock ${section} differs from materialized deployment manifest`);
  for (const section of depSections)
    for (const [name, spec] of Object.entries(manifest[section] || {})) {
      if (/(?:catalog|workspace|file|link|git|https?):/.test(spec))
        throw new Error(`Unsupported standalone deployment dependency ${name}`);
    }
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (!key) continue;
    if (
      !key.startsWith('node_modules/') ||
      pkg.link ||
      typeof pkg.version !== 'string' ||
      !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(pkg.integrity || '') ||
      new URL(pkg.resolved || 'invalid:', 'invalid:').protocol !== 'https:' ||
      new URL(pkg.resolved || 'invalid:', 'invalid:').hostname !== 'registry.npmjs.org'
    )
      throw new Error(`Unpinned or external npm deployment package ${key}`);
  }
  const overrides = npmWorkspaceOverrides(workspace);
  for (const [name, version] of Object.entries(overrides))
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (key.endsWith(`node_modules/${name}`) && pkg.version !== version)
        throw new Error(`Npm lock violates reviewed override ${name}`);
    }
  // pnpm patches cannot silently disappear when exporting to npm. Test-only
  // patches absent from this entire standalone graph are intentionally irrelevant.
  for (const selector of Object.keys(flatWorkspaceSection(workspace, 'patchedDependencies'))) {
    const match = selector.match(/^((?:@[^/]+\/)?[^@]+)@([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)$/);
    if (!match) throw new Error('Unsupported pnpm patch selector; review an explicit npm equivalent');
    if (
      Object.entries(lock.packages).some(
        ([key, pkg]) => key.endsWith(`node_modules/${match[1]}`) && pkg.version === match[2]
      )
    )
      throw new Error(`Standalone npm graph requires pnpm-only patch ${selector}; vendor/review it before deployment`);
  }
  return lock;
}

export function materializedPackageContents(original, workspace) {
  const catalog = parseCatalog(workspace),
    packageJson = JSON.parse(original);
  for (const section of depSections) {
    const deps = packageJson[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (spec !== 'catalog:') continue;
      const resolved = catalog.get(name);
      if (!resolved) throw new Error(`No catalog version found for ${name}`);
      deps[name] = resolved;
    }
  }
  const overrides = npmWorkspaceOverrides(workspace);
  if (packageJson.overrides && JSON.stringify(packageJson.overrides) !== JSON.stringify(overrides))
    throw new Error('Split-specific npm overrides differ from reviewed workspace policy');
  for (const section of depSections)
    for (const [name, version] of Object.entries(overrides)) {
      if (Object.hasOwn(packageJson[section] || {}, name)) packageJson[section][name] = version;
    }
  if (Object.keys(overrides).length) packageJson.overrides = overrides;
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicitTargets = args.filter((arg) => !arg.startsWith('--'));
  const targets = explicitTargets.length > 0 ? explicitTargets : defaultTargets;

  const workspace = fs.readFileSync(workspaceConfigPath, 'utf8');
  // Validate every lock before writing any generated manifests. Lock generation
  // is a separate explicit CLI action; deployment never re-resolves versions.
  const prepared = targets.map((target) => {
    const targetPath = path.join(workspaceRoot, target);
    const original = fs.readFileSync(targetPath, 'utf8');
    const contents = materializedPackageContents(original, workspace);
    if (defaultTargets.some((deployed) => path.resolve(workspaceRoot, deployed) === path.resolve(targetPath))) {
      const lockPath = path.join(path.dirname(targetPath), 'package-lock.json');
      validateNpmDeploymentLock(JSON.parse(contents), JSON.parse(fs.readFileSync(lockPath, 'utf8')), workspace);
    }
    return { target, targetPath, original, contents };
  });
  for (const item of prepared) {
    if (item.contents === item.original) continue;
    if (!dryRun) fs.writeFileSync(item.targetPath, item.contents);
    console.log(`[catalog-materialize] ${item.target}: validated immutable npm lock and generated manifest`);
  }
  if (dryRun) console.log('[catalog-materialize] Dry run only; no files modified.');
}
