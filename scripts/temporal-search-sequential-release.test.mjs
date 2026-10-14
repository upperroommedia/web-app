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
