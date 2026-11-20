import test from 'node:test';
import assert from 'node:assert/strict';
import { readRestoredMediaRecoveryPlan } from './temporal-restored-media-registration.mjs';
const id = '11111111-1111-1111-1111-111111111111';
function options(get) {
  const plan = { buildId: 'a'.repeat(40), image: 'fixed@sha256:' + 'b'.repeat(64) };
  return {
    plan,
    recoveryOperationId: id,
    firestore: {
      doc: (path) => {
        assert.equal(path, `_control/temporalCloudMediaRecovery-${id}`);
        return { get: () => get(plan) };
      },
    },
  };
}
test('fixed exact recovery source plan lookup only', async () => {
  const o = options((plan) => ({
    exists: true,
    get: (key) => {
      assert.equal(key, 'identityState.plan');
      return { ...plan, operationId: id };
    },
  }));
  assert.equal((await readRestoredMediaRecoveryPlan(o)).operationId, id);
});
for (const field of ['operationId', 'image', 'buildId'])
  test('foreign original ' + field + ' denies', async () => {
    const o = options((plan) => ({ exists: true, get: () => ({ ...plan, operationId: id, [field]: 'foreign' }) }));
    await assert.rejects(readRestoredMediaRecoveryPlan(o), /RESTORED_MEDIA_REGISTRATION_UNCONFIRMED/);
  });
test('original receipt never settles: bounded deny', async () => {
  const o = options(() => new Promise(() => {}));
  await assert.rejects(readRestoredMediaRecoveryPlan(o), /RESTORED_MEDIA_REGISTRATION_UNCONFIRMED/);
});
test('event-loop delayed native settlement cannot beat original deadline', async () => {
  const o = options((plan) => {
    const end = performance.now() + 5100;
    while (performance.now() < end) {}
    return { exists: true, get: () => ({ ...plan, operationId: id }) };
  });
  await assert.rejects(readRestoredMediaRecoveryPlan(o), /RESTORED_MEDIA_REGISTRATION_UNCONFIRMED/);
});
