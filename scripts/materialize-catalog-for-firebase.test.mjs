import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  defaultTargets,
  materializedPackageContents,
  npmWorkspaceOverrides,
  validateNpmDeploymentLock,
} from './materialize-catalog-for-firebase.mjs';
const root = new URL('..', import.meta.url).pathname,
  workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const tiny = 'catalog:\n  cookie: ^0.6.0\noverrides:\n  cookie: 0.7.0\n';
const manifest = { name: 'override-fixture', dependencies: { cookie: 'catalog:' }, engines: { node: '22' } };

test('all tracked split npm locks match materialized roots and every reviewed exact override', () => {
  for (const target of defaultTargets) {
    const pkg = JSON.parse(materializedPackageContents(readFileSync(join(root, target), 'utf8'), workspace)),
      lock = JSON.parse(readFileSync(join(root, target.replace('package.json', 'package-lock.json')), 'utf8'));
    assert.deepEqual(pkg.overrides, npmWorkspaceOverrides(workspace));
    assert.equal(validateNpmDeploymentLock(pkg, lock, workspace), lock);
    for (const [name, version] of Object.entries(pkg.overrides))
      if (pkg.dependencies[name]) assert.equal(pkg.dependencies[name], version);
  }
});

test('direct overrides remain exact and unsupported deeper/conditional/removal/alias selectors fail explicitly', () => {
  const pkg = JSON.parse(materializedPackageContents(JSON.stringify(manifest), tiny));
  assert.equal(pkg.dependencies.cookie, '0.7.0');
  assert.equal(pkg.overrides.cookie, '0.7.0');
  for (const entry of [
    '  "parent>bridge>cookie": 0.7.0',
    '  "parent*>cookie": 0.7.0',
    '  "parent@1.0.0>cookie": 0.7.0',
    '  cookie:\n    child: 0.7.0',
    '  cookie: -',
    '  cookie: "npm:other@0.7.0"',
    '  cookie: ^0.7.0',
  ])
    assert.throws(
      () =>
        materializedPackageContents(
          JSON.stringify(manifest),
          'catalog:\n  cookie: ^0.6.0\noverrides:\n' + entry + '\n'
        ),
      /Unsupported/
    );
  assert.throws(
    () => materializedPackageContents(JSON.stringify({ ...manifest, overrides: { cookie: '0.6.0' } }), tiny),
    /reviewed workspace/
  );
});

test('stale declarations, override drift, external resolutions and applicable pnpm-only patches block deployment', () => {
  const pkg = JSON.parse(
      materializedPackageContents(readFileSync(join(root, 'functions-core/package.json'), 'utf8'), workspace)
    ),
    original = JSON.parse(readFileSync(join(root, 'functions-core/package-lock.json'), 'utf8'));
  for (const change of ['root', 'override', 'external', 'integrity', 'link']) {
    const lock = structuredClone(original);
    const key = Object.keys(lock.packages).find((k) => k.endsWith('node_modules/cookie'));
    if (change === 'root') lock.packages[''].dependencies.axios = '9.9.9';
    if (change === 'override') lock.packages[key].version = '0.6.0';
    if (change === 'external') lock.packages[key].resolved = 'https://unreviewed.example/package.tgz';
    if (change === 'integrity') delete lock.packages[key].integrity;
    if (change === 'link') lock.packages[key].link = true;
    assert.throws(() => validateNpmDeploymentLock(pkg, lock, workspace));
  }
  const applicable = workspace.replace(
    /^patchedDependencies:[\s\S]*?(?=\n[^ #])/m,
    'patchedDependencies:\n  cookie@0.7.0: patches/cookie.patch\n'
  );
  assert.throws(() => validateNpmDeploymentLock(pkg, original, applicable), /pnpm-only patch/);
  // The existing firebase-functions-test patch is absent from this entire deployed graph.
  assert.ok(!Object.keys(original.packages).some((k) => k.endsWith('node_modules/firebase-functions-test')));
});

test('npm CLI accepts generated direct override without EOVERRIDE, and rejects the unconverted direct range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-eoverride-fixture-'));
  try {
    const user = join(dir, 'user.npmrc'),
      global = join(dir, 'global.npmrc');
    writeFileSync(user, '');
    writeFileSync(global, '');
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      NPM_CONFIG_USERCONFIG: user,
      NPM_CONFIG_GLOBALCONFIG: global,
      NPM_CONFIG_CACHE: join(dir, 'cache'),
    };
    const args = [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ];
    writeFileSync(join(dir, 'package.json'), materializedPackageContents(JSON.stringify(manifest), tiny));
    const good = spawnSync('npm', args, { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(good.status, 0, good.stderr);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
      lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    validateNpmDeploymentLock(pkg, lock, tiny);
    assert.equal(lock.packages['node_modules/cookie'].version, '0.7.0');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ ...manifest, dependencies: { cookie: '^0.6.0' }, overrides: { cookie: '0.7.0' } })
    );
    const bad = spawnSync('npm', args, { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /EOVERRIDE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('development functions root may still materialize catalog without a deployment lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'functions-dev-catalog-'));
  try {
    mkdirSync(join(dir, 'functions'));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'catalog:\n  example: 1.2.3\n');
    writeFileSync(
      join(dir, 'functions/package.json'),
      JSON.stringify({ name: 'functions', dependencies: { example: 'catalog:' } })
    );
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/materialize-catalog-for-firebase.mjs'), 'functions/package.json'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'functions/package.json'), 'utf8')).dependencies.example, '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('path aliases cannot bypass required split lock checks or partially materialize files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-lock-required-'));
  try {
    mkdirSync(join(dir, 'functions-core'));
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      `catalog:
  example: 1.2.3
`
    );
    const original = JSON.stringify({ name: 'functions-core', dependencies: { example: 'catalog:' } });
    writeFileSync(join(dir, 'functions-core/package.json'), original);
    for (const target of ['functions-core/package.json', './functions-core/package.json']) {
      const result = spawnSync(process.execPath, [join(root, 'scripts/materialize-catalog-for-firebase.mjs'), target], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(dir, 'functions-core/package.json'), 'utf8'), original);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const scopedPolicy = 'catalog:\n  parent: 1.0.0\noverrides:\n  "parent>child": 11.1.1\n';
function scopedLock(packages) {
  const pkg = JSON.parse(
    materializedPackageContents(
      JSON.stringify({ name: 'scoped-fixture', dependencies: { parent: '1.0.0' }, engines: { node: '22' } }),
      scopedPolicy
    )
  );
  const lock = {
    name: pkg.name,
    lockfileVersion: 3,
    packages: {
      '': { ...pkg },
      ...Object.fromEntries(
        Object.entries(packages).map(([key, value]) => [
          key,
          {
            version: '1.0.0',
            integrity: 'sha512-eA==',
            resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
            ...value,
          },
        ])
      ),
    },
  };
  return { pkg, lock };
}
test('literal scoped overrides translate to npm nested policy without rewriting direct parent declarations', () => {
  assert.deepEqual(npmWorkspaceOverrides(scopedPolicy), { parent: { child: '11.1.1' } });
  const both = 'catalog:\n  parent: ^1.0.0\noverrides:\n  parent: 1.2.3\n  parent>child: 11.1.1\n';
  const pkg = JSON.parse(
    materializedPackageContents(JSON.stringify({ name: 'fixture', dependencies: { parent: 'catalog:' } }), both)
  );
  assert.equal(pkg.dependencies.parent, '1.2.3');
  assert.deepEqual(pkg.overrides, { parent: { '.': '1.2.3', child: '11.1.1' } });
  assert.deepEqual(
    npmWorkspaceOverrides('catalog:\n  cookie: 1.0.0\noverrides:\n  "@scope/parent>@other/child": 1.2.3\n'),
    { '@scope/parent': { '@other/child': '1.2.3' } }
  );
  assert.throws(() => npmWorkspaceOverrides(scopedPolicy + '  child: 9.0.1\n'), /Conflicting/);
});
test('scoped closure checks actual hoisted dependency resolution and leaves unrelated child versions alone', () => {
  const { pkg, lock } = scopedLock({
    'node_modules/parent': { dependencies: { child: '^8.3.2' } },
    'node_modules/child': { version: '11.1.1' },
    'node_modules/unrelated': { dependencies: { child: '^9.0.0' } },
    'node_modules/unrelated/node_modules/child': { version: '9.0.1' },
  });
  assert.equal(validateNpmDeploymentLock(pkg, lock, scopedPolicy), lock);
  lock.packages['node_modules/child'].version = '8.3.2';
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /reviewed scoped override/);
});
test('nested scoped children cannot hide behind a correct hoisted version or a dependency cycle', () => {
  const { pkg, lock } = scopedLock({
    'node_modules/parent': { dependencies: { child: '^8.3.2', bridge: '1.0.0' } },
    'node_modules/child': { version: '11.1.1' },
    'node_modules/bridge': { dependencies: { child: '9.0.1', parent: '1.0.0' } },
    'node_modules/bridge/node_modules/child': { version: '9.0.1' },
  });
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /reviewed scoped override/);
  lock.packages['node_modules/bridge/node_modules/child'].version = '11.1.1';
  assert.equal(validateNpmDeploymentLock(pkg, lock, scopedPolicy), lock);
});
test('scoped policy rejects missing targets and stale present parents but allows absent parents', () => {
  const { pkg, lock } = scopedLock({ 'node_modules/parent': { dependencies: { child: '^8.3.2' } } });
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /Missing scoped/);
  delete lock.packages['node_modules/parent'].dependencies;
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /not a declared dependency/);
  delete lock.packages['node_modules/parent'];
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /Missing required root dependency parent/);
  pkg.dependencies = {};
  lock.packages[''].dependencies = {};
  assert.equal(validateNpmDeploymentLock(pkg, lock, scopedPolicy), lock);
});
test('flat all-occurrence validation still rejects an unrelated incorrect nested override', () => {
  const policy = scopedPolicy + '  cookie: 0.7.0\n';
  const { pkg, lock } = scopedLock({
    'node_modules/parent': { dependencies: { child: '^8.3.2' } },
    'node_modules/child': { version: '11.1.1' },
    'node_modules/unrelated/node_modules/cookie': { version: '0.6.0' },
  });
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, policy), /reviewed override cookie/);
});
test('literal selectors reject path-like segments and cannot mutate inherited object properties', () => {
  for (const selector of ['..>child', '@scope/..>child', '.hidden>child', '__proto__>child', 'parent>__proto__'])
    assert.throws(
      () => npmWorkspaceOverrides(`catalog:\n  child: 1.0.0\noverrides:\n  "${selector}": 1.2.3\n`),
      /Unsupported/
    );
  assert.deepEqual(npmWorkspaceOverrides('catalog:\n  child: 1.0.0\noverrides:\n  "constructor>child": 1.2.3\n'), {
    constructor: { child: '1.2.3' },
  });
  assert.equal(Object.child, undefined);
});
test('missing required intermediate edges cannot hide a stale descendant from scoped validation', () => {
  const { pkg, lock } = scopedLock({
    'node_modules/parent': { dependencies: { child: '^8.3.2', bridge: '1.0.0' } },
    'node_modules/child': { version: '11.1.1' },
    'node_modules/bridge/node_modules/child': { version: '9.0.1' },
  });
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, scopedPolicy), /Missing required dependency bridge/);
  delete lock.packages['node_modules/parent'].dependencies.bridge;
  lock.packages['node_modules/parent'].optionalDependencies = { bridge: '1.0.0' };
  assert.equal(validateNpmDeploymentLock(pkg, lock, scopedPolicy), lock);
});
test('scoped package namespace intermediate resolution matches Node and cannot hide a stale child', () => {
  const policy = 'catalog:\n  child: 1.0.0\noverrides:\n  "@scope/parent>child": 11.1.1\n';
  const { pkg, lock } = scopedLock({
    'node_modules/@scope/parent': { dependencies: { child: '^8.3.2' } },
    'node_modules/@scope/node_modules/child': { version: '9.0.1' },
    'node_modules/child': { version: '11.1.1' },
  });
  pkg.dependencies = { '@scope/parent': '1.0.0' };
  lock.packages[''].dependencies = pkg.dependencies;
  assert.throws(() => validateNpmDeploymentLock(pkg, lock, policy), /reviewed scoped override/);
  lock.packages['node_modules/@scope/node_modules/child'].version = '11.1.1';
  assert.equal(validateNpmDeploymentLock(pkg, lock, policy), lock);
});
