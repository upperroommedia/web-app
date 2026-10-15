import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  buildStorageRulesRepairPlan,
  assertStorageRulesRepairAuthority,
  verifyStorageRulesObservation,
  repairStorageRules,
  parseStorageRulesRepairArgs,
  storageRulesRepairFirebaseConfig,
} from './temporal-storage-rules-repair.mjs';
import { hash, proofDigest, nativeSnapshotProof } from './temporal-release-runtime.mjs';
const release = {
  projectId: 'urm-app-staging',
  environment: 'staging',
  releaseId: 'existing-release',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'a'.repeat(40),
  mode: 'initial-cutover',
  domains: ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'],
};
const originalRules = "rules_version = '2';\n// isolated fixture\n.data.kind == 'upload.source.start'\n";
const operationId = '6e663137-cd67-405d-bb4c-36f918176573';
const inputs = {
  release,
  revision: 17,
  runtimeCommit: release.compatibilityCommit,
  operatorCommit: 'b'.repeat(40),
  originalRules,
  desiredSHA256: hash(originalRules.replace('upload.source.start', 'upload.create')),
  bucket: 'urm-app-staging.firebasestorage.app',
  expectedRuleset: 'projects/urm-app-staging/rulesets/original-rules',
};
const plan = () => buildStorageRulesRepairPlan(inputs);
const control = () => ({
  schemaVersion: 1,
  releaseId: release.releaseId,
  revision: 17,
  admission: 'paused',
  legacyAdmissionCutoff: { seconds: 123, nanoseconds: 456 },
  domains: Object.fromEntries(
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
      domain,
      { owner: domain === 'search' ? 'legacy' : 'temporal', admission: 'paused' },
    ])
  ),
});
const state = () => ({
  ...release,
  controlRevision: 17,
  phase: 'paused-for-recovery',
  pausedFrom: 'open',
  originalHistory: 'unchanged',
});
function database() {
  let tick = 1;
  const rows = new Map(),
    writes = [];
  const stamp = (n) => ({ seconds: 100, nanoseconds: n, toDate: () => new Date(100000) });
  const put = (path, data) => {
    const prior = rows.get(path);
    rows.set(path, { data: structuredClone(data), create: prior?.create ?? tick, update: tick++ });
  };
  const snapshot = (path) => {
    const row = rows.get(path);
    return {
      exists: !!row,
      data: () => row && structuredClone(row.data),
      createTime: row && stamp(row.create),
      updateTime: row && stamp(row.update),
    };
  };
  put('_control/temporalRelease', control());
  put('_control/temporalReleaseState', state());
  put('durableJobs/owned-job', { kind: 'upload.create', state: 'awaiting_source', sentinel: 'preserve' });
  const db = {
    doc: (path) => ({ path, get: async () => snapshot(path) }),
    runTransaction: async (run) => {
      const pending = [];
      await run({
        get: async (ref) => snapshot(ref.path),
        create: (ref, data) => {
          assert(!rows.has(ref.path));
          pending.push(['create', ref.path, data]);
        },
        delete: (ref) => pending.push(['delete', ref.path]),
      });
      for (const [kind, path, data] of pending) {
        writes.push([kind, path]);
        if (kind === 'delete') rows.delete(path);
        else put(path, data);
      }
    },
  };
  return { db, rows, writes, put, snapshot };
}
function fixture() {
  const store = database();
  let live = inputs.originalRules,
    ruleset = inputs.expectedRuleset,
    deploys = 0,
    reads = 0;
  const observation = () => ({
    release: {
      name: `projects/urm-app-staging/releases/firebase.storage/${inputs.bucket}`,
      rulesetName: ruleset,
      updateTime: '2026-10-15T00:00:00Z',
    },
    ruleset: { name: ruleset, source: { files: [{ name: 'storage.rules', content: live }] } },
  });
  const readRules = async () => {
    reads++;
    return observation();
  };
  const deploy = async () => {
    deploys++;
    live = plan().repairedRules;
    ruleset = 'projects/urm-app-staging/rulesets/repaired-rules';
  };
  return {
    ...store,
    args: {
      db: store.db,
      release,
      plan: plan(),
      operationId,
      evidence: { descriptorSHA256: 'c'.repeat(64), operator: 'operator@example.test' },
      readRules,
      deploy,
    },
    readRules,
    deploy,
    observation,
    setLive: (value) => {
      live = value;
    },
    deployCount: () => deploys,
    readCount: () => reads,
  };
}
test('artifact derivation is exactly one correction from pinned original, never candidate extra privacy changes', () => {
  const p = plan();
  assert.equal(p.repairedRules, originalRules.replace('upload.source.start', 'upload.create'));
  assert.equal(p.beforeSHA256, hash(originalRules));
  for (const patch of [
    { release: { ...release, projectId: 'urm-app' } },
    { runtimeCommit: 'c'.repeat(40) },
    { operatorCommit: 'dirty' },
    { desiredSHA256: '0'.repeat(64) },
    { originalRules: originalRules + originalRules },
    { bucket: 'urm-app.appspot.com' },
  ])
    assert.throws(() => buildStorageRulesRepairPlan({ ...inputs, ...patch }));
});
test('only a matching paused recovery of the existing opened release is authorized', () => {
  assert.doesNotThrow(() => assertStorageRulesRepairAuthority(control(), state(), release, 17));
  for (const patch of [
    { admission: 'open' },
    { revision: 18 },
    { releaseId: 'other' },
    { domains: { ...control().domains, media: { owner: 'legacy', admission: 'paused' } } },
  ])
    assert.throws(() => assertStorageRulesRepairAuthority({ ...control(), ...patch }, state(), release, 17));
  for (const patch of [
    { phase: 'open' },
    { pausedFrom: 'ui-frozen' },
    { compatibilityCommit: 'c'.repeat(40) },
    { controlRevision: 18 },
  ])
    assert.throws(() => assertStorageRulesRepairAuthority(control(), { ...state(), ...patch }, release, 17));
});
test('argument parser requires exact staging authority and refuses arbitrary command tails', () => {
  const args = [
    '--storage-rules-repair',
    '--inspect',
    '--project',
    'urm-app-staging',
    '--release',
    'release.json',
    '--runtime-root',
    'runtime',
    '--repair-commit',
    'b'.repeat(40),
    '--rules-sha256',
    inputs.desiredSHA256,
    '--expected-ruleset',
    inputs.expectedRuleset,
    '--revision',
    '17',
    '--output',
    'out.json',
  ];
  assert.equal(parseStorageRulesRepairArgs(args).apply, false);
  for (const suffix of [['--', 'firebase', 'deploy'], ['--apply'], ['--project', 'urm-app']])
    assert.throws(() => parseStorageRulesRepairArgs([...args, ...suffix]));
});
test('live Rules source/name and original ruleset must match exactly, not just content hash', () => {
  const f = fixture(),
    valid = f.observation();
  assert.doesNotThrow(() => verifyStorageRulesObservation(valid, plan(), originalRules, inputs.expectedRuleset));
  for (const patch of [
    { release: { ...valid.release, name: valid.release.name.replace('staging', 'production') } },
    { release: { ...valid.release, rulesetName: 'projects/urm-app/rulesets/other' } },
    { ruleset: { ...valid.ruleset, source: { files: [{ name: 'storage.rules', content: originalRules + 'extra' }] } } },
    { ruleset: { ...valid.ruleset, source: { files: [] } } },
  ])
    assert.throws(() =>
      verifyStorageRulesObservation({ ...valid, ...patch }, plan(), originalRules, inputs.expectedRuleset)
    );
});
test('success writes only the owned operation and immutable audit; native control/state/job stay unchanged', async () => {
  const f = fixture(),
    before = ['_control/temporalRelease', '_control/temporalReleaseState', 'durableJobs/owned-job'].map((path) =>
      proofDigest(nativeSnapshotProof(f.snapshot(path)))
    );
  const result = await repairStorageRules(f.args);
  assert.equal(f.deployCount(), 1);
  assert.equal(result.after.sourceSHA256, inputs.desiredSHA256);
  assert(!f.rows.has('_control/temporalReleaseOperation'));
  assert(f.rows.has(result.auditPath));
  assert.deepEqual(
    ['_control/temporalRelease', '_control/temporalReleaseState', 'durableJobs/owned-job'].map((path) =>
      proofDigest(nativeSnapshotProof(f.snapshot(path)))
    ),
    before
  );
  assert.deepEqual(
    f.writes.map(([, path]) => path),
    ['_control/temporalReleaseOperation', result.auditPath, '_control/temporalReleaseOperation']
  );
});
test('an existing operation or conflicting live rules stops before CLI deployment', async () => {
  const f = fixture();
  f.put('_control/temporalReleaseOperation', { operationId: 'other' });
  await assert.rejects(() => repairStorageRules(f.args), /OPERATION_HELD/);
  assert.equal(f.deployCount(), 0);
  assert.deepEqual(f.writes, []);
  const conflict = fixture();
  conflict.setLive(originalRules + 'independent change');
  await assert.rejects(() => repairStorageRules(conflict.args), /LIVE_RULES_MISMATCH/);
  assert.equal(conflict.deployCount(), 0);
  assert.deepEqual(conflict.writes, []);
});
test('CLI failure and a conflicting post-deploy ruleset retain the exact operation without an audit', async () => {
  for (const deploy of [
    async () => {
      throw new Error('CLI_FAILED');
    },
    async () => {},
  ]) {
    const f = fixture();
    await assert.rejects(() => repairStorageRules({ ...f.args, deploy }));
    assert(f.rows.has('_control/temporalReleaseOperation'));
    assert(![...f.rows.keys()].some((p) => p.includes('temporalStorageRulesRepair-')));
  }
});
test('a changed native control timestamp or replaced own lock cannot be silently settled', async () => {
  for (const path of [
    '_control/temporalRelease',
    '_control/temporalReleaseState',
    '_control/temporalReleaseOperation',
  ]) {
    const f = fixture();
    await assert.rejects(
      () =>
        repairStorageRules({
          ...f.args,
          deploy: async () => {
            await f.deploy();
            f.put(path, f.snapshot(path).data());
          },
        }),
      /NATIVE_AUTHORITY_CHANGED/
    );
    assert(f.rows.has('_control/temporalReleaseOperation'));
  }
});
test('live drift after lock acquisition is rejected before CLI and retains owned lock', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      repairStorageRules({
        ...f.args,
        readRules: async () => {
          if (f.readCount() === 1) f.setLive(originalRules + 'raced');
          return f.readRules();
        },
      }),
    /LIVE_RULES_MISMATCH/
  );
  assert.equal(f.deployCount(), 0);
  assert(f.rows.has('_control/temporalReleaseOperation'));
});
test('guard retains generic phase policy and routes only the explicit rules repair branch', () => {
  const guard = readFileSync(new URL('./temporal-deploy-guard.mjs', import.meta.url), 'utf8');
  assert(guard.includes("!['ui-frozen', 'ownership-changed'].includes(phase)"));
  assert(guard.includes("import('./temporal-storage-rules-repair.mjs')"));
  const source = readFileSync(new URL('./temporal-storage-rules-repair.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--only',\s*'storage'/);
  assert(!source.includes("'--force'"));
});

test('official Firebase Config resolves the absolute config directory and publishes exactly relative storage.rules', () => {
  const require = createRequire(import.meta.url);
  const { Config } = require('firebase-tools/lib/config');
  const { RulesDeploy, RulesetServiceType } = require('firebase-tools/lib/rulesDeploy');
  const directory = mkdtempSync(join(tmpdir(), 'urm-storage-config-contract-'));
  try {
    const configPath = join(directory, 'firebase.json');
    writeFileSync(join(directory, 'storage.rules'), plan().repairedRules);
    writeFileSync(configPath, JSON.stringify(storageRulesRepairFirebaseConfig(inputs.bucket)));
    const config = Config.load({ configPath, cwd: tmpdir() });
    assert.equal(config.projectDir, directory);
    assert.deepEqual(config.get('storage'), [{ bucket: inputs.bucket, rules: 'storage.rules' }]);
    assert.equal(config.get('functions'), undefined);
    const deployment = new RulesDeploy({ config, project: 'urm-app-staging' }, RulesetServiceType.FIREBASE_STORAGE);
    deployment.addFile(config.get('storage')[0].rules);
    assert.deepEqual(deployment.rulesFiles[0].files, [{ name: 'storage.rules', content: plan().repairedRules }]);
    assert.throws(() => storageRulesRepairFirebaseConfig('urm-app.appspot.com'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
