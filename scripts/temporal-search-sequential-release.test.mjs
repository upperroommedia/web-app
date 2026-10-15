import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('actual controller completes sequential staging search onboarding without rebuilding predecessor provider epoch', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.phase, 'complete');
  assert.deepEqual(
    proof.actions.map((row) => row.action),
    [
      'freeze-ui',
      'compatibility-ready',
      'drain',
      'provider-usage-ready',
      'pause',
      'resume',
      'workers-ready',
      'take-ownership',
      'backend-ready',
      'bootstrap-search',
      'rollout-ui',
      'open',
      'restore-auto',
    ]
  );
  for (const field of [
    'providerBodyUnchanged',
    'providerNativeIdentityUnchanged',
    'freshCutoff',
    'earlyDrainRejected',
    'otherSixPreserved',
    'providerTamperingRejected',
    'actualValidators',
  ])
    assert.equal(proof[field], true);
  assert.deepEqual(proof.rejectedBoundaries, [
    'marker body changed',
    'marker missing',
    'archived predecessor changed',
    'first six owner drift',
    'unfinished non-search job',
    'epoch changed at open transaction',
    'status changed at open transaction',
  ]);
  assert.deepEqual(proof.rejectedRtdbBoundaries, [
    'workers-ready:cli',
    'workers-ready:auth',
    'workers-ready:cleanup',
    'open:cli',
    'open:auth',
    'open:cleanup',
  ]);
  assert.deepEqual(
    proof.rtdbCanaryCalls.filter(({ failure }) => failure === null).map(({ action }) => action),
    ['workers-ready', 'take-ownership', 'open', 'open', 'open']
  );
  assert.equal(proof.legacyBackfillInvoked, false);
  assert.equal(proof.jobCount, 5);
});

test('actual bundle controller rejects source/resource/current-head/native races and reconciles both unknown ACK outcomes', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
      'runtime-bundle',
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.result, 'passed');
  assert.equal(proof.cases.length, 9);
  assert.equal(proof.originalFailedJobsPreserved, true);
  assert.equal(proof.newGenerationCreatedByController, false);
});

test('actual controller migrates only absent legacy identity under native CAS and explicitly reconciles both unknown ACK outcomes', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
      'ui-identity-migration',
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.result, 'passed');
  assert.equal(proof.cases.length, 5);
  assert.equal(proof.noAppHostingWrites, true);
});

test('actual 13-action controller accepts only verified canonical project-number UI names', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
      'ui-canonical',
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.phase, 'complete');
  assert.equal(proof.actions.length, 13);
});

test('actual complete UI pause/resume verifies canonical build against explicit saved checkpoint', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
      'ui-canonical-recovery',
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.phase, 'ui-ready');
  assert.deepEqual(
    proof.actions.slice(-2).map((row) => row.action),
    ['pause', 'resume']
  );
});

test('actual controller blocks missing/private mandatory callable transport at readiness and preopen', async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-vm-modules',
      new URL('./tests/fixtures/temporal-search-sequential-release.mjs', import.meta.url).pathname,
      'callable-access',
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
  );
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.phase, 'complete');
  assert.equal(proof.rejectedCallableAccess.length, 14);
  for (const action of ['backend-ready', 'open']) {
    const paths = new Set(
      proof.callableIamReads.filter((row) => row.action === action && row.fault === null).map((row) => row.path)
    );
    assert.equal(paths.size, 3);
    for (const id of ['submitdurablejob', 'getdurablejobreceipt', 'commanddurablejob'])
      assert([...paths].some((path) => path.endsWith('/services/' + id + ':getIamPolicy')));
  }
});
