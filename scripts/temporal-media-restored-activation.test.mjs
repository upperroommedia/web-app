import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activateRestoredCloudRunMedia, assertRestoredActivationState } from './temporal-media-restored-activation.mjs';
import { restoredMediaBootV2 } from './temporal-restored-media-boot-policy.mjs';
import { restoredMediaActivationRuntime } from './temporal-media-restored-runtime.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { restoredActivationFixture } from './tests/fixtures/restored-media-activation.mjs';
{
  test('canonical runtime denies before origin/checkpoint/HTTP', async () => {
    const f = restoredActivationFixture();
    f.options.runtime = restoredMediaActivationRuntime({
      options: () => {
        throw Error('must not read');
      },
    });
    await assert.rejects(activateRestoredCloudRunMedia(f.options), /RUNTIME_UNAVAILABLE/);
    assert.equal(f.saved, undefined);
    assert.equal(f.patches, 0);
  });
  test('separate immutable start and retained registration; resume never rereads zero origin', async () => {
    const f = restoredActivationFixture();
    const result = await activateRestoredCloudRunMedia(f.options);
    assert.equal(result.disposition, 'retained');
    assert.equal(f.patches, 1);
    assert.equal(f.originReads, 1);
    assert.ok(f.calls.indexOf('save:starting:attempted:undefined') < f.calls.indexOf('PATCH'));
    f.options.saved = f.saved;
    const again = await activateRestoredCloudRunMedia(f.options);
    assert.deepEqual(again, result);
    assert.equal(f.patches, 1);
    assert.equal(f.originReads, 1);
  });
  test('lost PATCH ACK only reads; no LRO/pool success inference or resend', async () => {
    const f = restoredActivationFixture(),
      api = f.options.api;
    f.options.api = async (...a) => {
      const r = await api(...a);
      if (a[1] === 'PATCH') throw Error('lost ACK');
      return r;
    };
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.saved.start.stage, 'attempted');
    assert.equal(f.patches, 1);
    f.options.saved = f.saved;
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.patches, 1);
    assert.equal(f.originReads, 1);
  });
  test('lost retained completion ACK never becomes cleanup or second PATCH', async () => {
    const f = restoredActivationFixture(),
      save = f.options.save;
    f.options.save = async (s) => {
      await save(s);
      if (s.disposition === 'retained') throw Error('lost checkpoint ACK');
    };
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.saved.disposition, 'retained');
    assert.equal(f.patches, 1);
    assert.equal(f.saved.cleanup, undefined);
    f.options.saved = f.saved;
    await activateRestoredCloudRunMedia(f.options);
    assert.equal(f.patches, 1);
  });
  test('unused cleanup preserves quota proof without fresh quota reads', async () => {
    const f = restoredActivationFixture();
    let originalQuotaCalls;
    f.options.runtime.registration = async () => {
      originalQuotaCalls = f.quotaReads;
      f.options.runtime.quota = async () => {
        throw Error('quota lost');
      };
      throw Error('registration failed');
    };
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.saved.disposition, 'stopped');
    assert.equal(f.patches, 2);
    assert.equal(f.quotaReads, originalQuotaCalls);
    f.options.saved = f.saved;
    await activateRestoredCloudRunMedia(f.options);
    assert.equal(f.patches, 2);
  });
  test('unknown work prevents unused cleanup scale', async () => {
    const f = restoredActivationFixture();
    f.options.runtime.registration = async () => {
      throw Error();
    };
    f.options.runtime.unused = async () => {
      throw Error('unknown work');
    };
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.saved.stage, 'cleaning');
    assert.equal(f.patches, 1);
  });
  test('post-checkpoint phase drift fences actual request', async () => {
    const f = restoredActivationFixture(),
      save = f.options.save;
    f.options.save = async (s) => {
      await save(s);
      if (s.start?.stage === 'attempted')
        f.options.runtime.phase = async () => {
          throw Error('drift');
        };
    };
    await assert.rejects(activateRestoredCloudRunMedia(f.options));
    assert.equal(f.patches, 0);
    assert.equal(f.saved.start.stage, 'attempted');
  });
  test('malformed or ordinary activation lineage cannot replace restored origin', async () => {
    const f = restoredActivationFixture();
    await activateRestoredCloudRunMedia(f.options);
    for (const mutate of [
      (s) => (s.plan.origin.kind = 'zero-pool'),
      (s) => (s.plan.operationId = s.plan.recoveryOperationId),
      (s) => (s.plan.receiptIds.recovery = s.plan.receiptIds.pool),
      (s) => (s.registration.pool = { ...s.registration.pool, etag: 'foreign' }),
    ]) {
      const s = f.saved;
      mutate(s);
      assert.throws(() => assertRestoredActivationState(s));
    }
  });
}

test('registration deadline reaches guarded unused cleanup', async () => {
  const f = restoredActivationFixture();
  f.options.runtime.registration = () => new Promise(() => {});
  const result = await Promise.race([
    activateRestoredCloudRunMedia(f.options).then(
      () => 'retained',
      () => 'denied'
    ),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 5600)),
  ]);
  assert.equal(result, 'denied');
  assert.equal(f.saved.disposition, 'stopped');
  assert.equal(f.patches, 2);
});
test('final pool await cannot renew original registration sample', async () => {
  const f = restoredActivationFixture(),
    read = f.options.runtime.readPool;
  let registered = false,
    delayed = false;
  const register = f.options.runtime.registration;
  f.options.runtime.registration = async (scope) => {
    registered = true;
    return register(scope);
  };
  f.options.runtime.readPool = async (scope) => {
    if (registered && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 5100));
    }
    return read(scope);
  };
  await assert.rejects(activateRestoredCloudRunMedia(f.options));
  assert.equal(f.saved.disposition, 'stopped');
  assert.equal(f.patches, 2);
});

test('v2 waits on its named pending START before checking the settled provider phase', async () => {
  const f = restoredActivationFixture();
  f.options.bootPolicy = restoredMediaBootV2;
  const api = f.options.api;
  let reads = 0;
  let settled = false;
  f.options.api = async (...args) => {
    const response = await api(...args);
    if (args[1] === 'PATCH') return response;
    assert.equal(response.name, f.saved.start.nativeOperation);
    reads++;
    if (reads === 1) return { name: response.name, done: false };
    settled = true;
    return response;
  };
  const phase = f.options.runtime.phase;
  f.options.runtime.phase = async (scope) => {
    if (scope.transition?.stage === 'acknowledged') assert.ok(settled);
    return phase(scope);
  };
  assert.equal((await activateRestoredCloudRunMedia(f.options)).disposition, 'retained');
  assert.equal(reads, 2);
  assert.equal(f.patches, 1);
});

test('v2 inconclusive registration leaves its original START held and allows same-UUID readback', async () => {
  const f = restoredActivationFixture();
  f.options.bootPolicy = restoredMediaBootV2;
  const phase = f.options.runtime.phase;
  f.options.runtime.phase = async (scope) => {
    if (scope.key === 'retained') throw new Error('inconclusive final phase');
    return phase(scope);
  };
  await assert.rejects(activateRestoredCloudRunMedia(f.options), /V2_REGISTRATION_UNCONFIRMED/);
  assert.equal(f.observations, 1);
  assert.equal(f.saved.stage, 'started');
  assert.equal(f.saved.start.stage, 'completed');
  assert.equal(f.saved.cleanup, undefined);
  assert.equal(f.patches, 1);
  f.options.saved = f.saved;
  f.options.runtime.phase = phase;
  assert.equal((await activateRestoredCloudRunMedia(f.options)).disposition, 'retained');
  assert.equal(f.patches, 1);
});

test('v2 local pre-send GET rejection is not a PATCH rejection and cannot resend', async () => {
  const f = restoredActivationFixture();
  f.options.bootPolicy = restoredMediaBootV2;
  const save = f.options.save;
  f.options.save = async (state) => {
    await save(state);
    if (state.start?.stage !== 'attempted') return;
    f.options.runtime.quota = async () => {
      throw Object.assign(new Error('credential settled GET was rejected'), { status: 412 });
    };
  };
  await assert.rejects(activateRestoredCloudRunMedia(f.options));
  assert.equal(f.saved.start.stage, 'attempted');
  assert.equal(f.patches, 0);
  f.options.saved = f.saved;
  await assert.rejects(activateRestoredCloudRunMedia(f.options));
  assert.equal(f.patches, 0);
});
