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
  const result = Object.create(null);
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
const packageNamePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const exactVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
function reviewedWorkspaceOverrides(workspace) {
  const flat = Object.create(null),
    scoped = [];
  for (const [selector, version] of Object.entries(flatWorkspaceSection(workspace, 'overrides'))) {
    const names = selector.split('>');
    if (
      !exactVersionPattern.test(version) ||
      names.length > 2 ||
      names.some((name) => !packageNamePattern.test(name)) ||
      (names.length === 2 && names[0] === names[1])
    )
      throw new Error(`Unsupported pnpm override ${selector}; review an explicit npm equivalent`);
    if (names.length === 1) flat[selector] = version;
    else scoped.push({ parent: names[0], child: names[1], version });
  }
  for (const { parent, child, version } of scoped) {
    if (flat[child] && flat[child] !== version)
      throw new Error(`Conflicting flat/scoped override for ${parent}>${child}`);
  }
  return { flat, scoped };
}
/** Literal ancestor/child overrides only; no ranges, aliases, wildcards or deeper selector grammar. */
export function npmWorkspaceOverrides(workspace) {
  const { flat, scoped } = reviewedWorkspaceOverrides(workspace);
  const translated = { ...flat };
  for (const { parent, child, version } of scoped) {
    const current = Object.hasOwn(translated, parent) ? translated[parent] : undefined;
    if (!current || typeof current === 'string')
      translated[parent] = { ...(current ? { '.': current } : {}), [child]: version };
    else current[child] = version;
  }
  return translated;
}
function packageAtPath(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}
/** Resolve a lock edge by Node's ancestor search, including hoisted and scoped packages. */
function resolveLockDependency(packages, from, name) {
  let directory = from;
  while (true) {
    // Node searches namespace directories too (@scope/node_modules), but skips
    // generating duplicate node_modules/node_modules lookup locations.
    if (path.posix.basename(directory) !== 'node_modules') {
      const candidate = `${directory ? `${directory}/` : ''}node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
    }
    if (!directory) return undefined;
    const parent = path.posix.dirname(directory);
    directory = parent === '.' ? '' : parent;
  }
}

function validateScopedOverrides(lock, scoped) {
  if (scoped.length) {
    const root = lock.packages[''];
    for (const name of Object.keys({ ...root.dependencies, ...root.optionalDependencies })) {
      if (!resolveLockDependency(lock.packages, '', name) && !Object.hasOwn(root.optionalDependencies || {}, name))
        throw new Error(`Missing required root dependency ${name} in scoped override closure`);
    }
  }
  for (const { parent, child, version } of scoped) {
    for (const [parentPath, pkg] of Object.entries(lock.packages)) {
      if (!parentPath || packageAtPath(parentPath) !== parent) continue;
      // A present parent with a removed/renamed target means this policy is stale.
      if (!Object.hasOwn({ ...pkg.dependencies, ...pkg.optionalDependencies }, child))
        throw new Error(`Scoped override target is not a declared dependency: ${parent}>${child}`);
      const pending = [parentPath],
        seen = new Set();
      while (pending.length) {
        const from = pending.pop();
        if (seen.has(from)) continue;
        seen.add(from);
        const current = lock.packages[from];
        for (const name of Object.keys({ ...current.dependencies, ...current.optionalDependencies })) {
          const resolved = resolveLockDependency(lock.packages, from, name);
          if (!resolved) {
            if (name === child) throw new Error(`Missing scoped override dependency ${parent}>${child}`);
            if (!Object.hasOwn(current.optionalDependencies || {}, name))
              throw new Error(`Missing required dependency ${name} in scoped override closure at ${from}`);
            continue; // Only explicitly optional cross-platform packages may be absent.
          }
          if (name === child && lock.packages[resolved].version !== version)
            throw new Error(`Npm lock violates reviewed scoped override ${parent}>${child} at ${resolved}`);
          pending.push(resolved);
        }
      }
    }
  }
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
  const { flat, scoped } = reviewedWorkspaceOverrides(workspace);
  for (const [name, version] of Object.entries(flat))
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (key.endsWith(`node_modules/${name}`) && pkg.version !== version)
        throw new Error(`Npm lock violates reviewed override ${name}`);
    }
  validateScopedOverrides(lock, scoped);
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
    for (const [name, version] of Object.entries(reviewedWorkspaceOverrides(workspace).flat)) {
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
