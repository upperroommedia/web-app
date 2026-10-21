import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRecoveryFixture as fixture } from './tests/fixtures/media-recovery.mjs';
import { readMediaRecoveryNormalOrigin } from './temporal-bootstrap-pool.mjs';
import { runMediaRecoveryCycle } from './temporal-media-recovery-cycle.mjs';
import { canonicalMediaRecoveryRuntime } from './temporal-media-recovery-runtime.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
test('separate controlled revision cycle keeps ancestor receipts and restores NEW normal-zero lineage', async () => {
  const f = await fixture(),
    ancestors = hash(f.options.receipts),
    origin = structuredClone(f.f.pool);
  const result = await runMediaRecoveryCycle(f.options);
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic', 'start', 'stop', 'restore']
  );
  assert.equal(hash(f.options.receipts), ancestors);
  assert.equal(result.plan.origin.uid, origin.uid);
  assert.notEqual(result.restore.pool.revision, result.plan.origin.revision);
  assert.equal(result.restore.pool.desiredManualInstanceCount, 0);
  assert.equal(result.stage, 'completed');
  assert.deepEqual(f.f.pool.template, result.plan.normalTemplate);
  const count = f.calls.length;
  await runMediaRecoveryCycle({ ...f.options, saved: f.saved });
  assert.equal(f.calls.length, count);
  // New lineage is NOT relabelled as the old normal bootstrap origin.
  await assert.rejects(readMediaRecoveryNormalOrigin({ ...f.options, saved: undefined }));
});
test('canonical runtime is fixed-deny BEFORE any cycle checkpoint or API request', async () => {
  const f = await fixture();
  f.options.runtime = canonicalMediaRecoveryRuntime;
  const count = f.f.calls.length;
  await assert.rejects(runMediaRecoveryCycle(f.options), /DIAGNOSTIC_RUNTIME_UNAVAILABLE/);
  assert.equal(f.saved, undefined);
  assert.equal(f.f.calls.length, count);
  assert.equal(f.calls.length, 0);
});
for (const key of ['diagnostic', 'start', 'stop', 'restore'])
  test(`unknown ${key} ACK stays GET-only and cannot cross to a later transition`, async () => {
    const f = await fixture(),
      api = f.options.api;
    f.options.api = async (...args) => {
      const result = await api(...args);
      if (args[1] === 'PATCH' && f.calls.at(-1).key === key) throw new Error('CONTROLLED_UNKNOWN_ACK');
      return result;
    };
    await assert.rejects(runMediaRecoveryCycle(f.options));
    assert.equal(f.saved[key].stage, 'attempted');
    const count = f.calls.length;
    await assert.rejects(runMediaRecoveryCycle({ ...f.options, saved: f.saved }));
    assert.equal(f.calls.length, count);
  });
test('recovery failure still drains/stops/restores the exact owned diagnostic revision', async () => {
  const f = await fixture();
  f.options.runtime.execute = async () => {
    throw new Error('CONTROLLED_FAILURE');
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic', 'start', 'stop', 'restore']
  );
  assert.equal(f.saved.stage, 'completed');
  assert.equal(f.saved.recoveryFailed, true);
  await assert.rejects(runMediaRecoveryCycle({ ...f.options, saved: f.saved }));
});
test('uncertain drain cannot zero a working/uncertain diagnostic candidate', async () => {
  const f = await fixture();
  f.options.runtime.drain = async () => {
    throw new Error('CONTROLLED_UNKNOWN_WORK');
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic', 'start']
  );
  assert.equal(f.f.pool.scaling.manualInstanceCount, 1);
});
test('quota API loss after allocation cannot prevent owned safe deallocation/restoration', async () => {
  const f = await fixture(),
    api = f.options.api;
  let lost = false;
  f.options.api = (...args) => {
    if (lost && args[0].includes('cloudquotas')) throw new Error('CONTROLLED_QUOTA_UNAVAILABLE');
    return api(...args);
  };
  f.options.runtime.execute = async ({ plan }) => {
    lost = true;
    return {
      kind: 'recovery',
      operationId: plan.operationId,
      bindingDigest: plan.bindingDigest,
      buildId: plan.buildId,
      image: plan.image,
      proofSHA256: 'f'.repeat(64),
    };
  };
  const result = await runMediaRecoveryCycle(f.options);
  assert.equal(result.stage, 'completed');
  assert.equal(f.f.pool.scaling.manualInstanceCount, 0);
});
test('post-checkpoint native authority drift denies template PATCH', async () => {
  const f = await fixture(),
    save = f.options.save;
  let deny = false;
  f.options.save = async (next) => {
    await save(next);
    if (next.diagnostic?.stage === 'attempted') deny = true;
  };
  f.options.authorizeMutation = async () => {
    if (deny) throw new Error('CONTROLLED_DRIFT');
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.equal(f.calls.length, 0);
});

for (const mode of ['quota-unavailable', 'expired', 'definite-rejection'])
  test(`never-started cleanup / ${mode}`, async () => {
    const f = await fixture(),
      api = f.options.api,
      save = f.options.save,
      now = Date.now;
    let stopQuota = false;
    try {
      f.options.api = async (...args) => {
        if (stopQuota && args[0].includes('cloudquotas')) throw new Error('CONTROLLED_QUOTA_LOSS');
        if (mode === 'definite-rejection' && args[1] === 'PATCH' && args[2].scaling?.manualInstanceCount === 1) {
          if (args[3]) await args[3]();
          throw Object.assign(new Error('CONTROLLED_REJECTED'), { status: 403 });
        }
        return api(...args);
      };
      f.options.save = async (next) => {
        await save(next);
        if (next.diagnostic?.stage === 'completed') {
          if (mode === 'quota-unavailable') stopQuota = true;
          if (mode === 'expired') Date.now = () => now() + 300001;
        }
      };
      await assert.rejects(runMediaRecoveryCycle(f.options));
      assert.equal(f.saved.stage, 'completed');
      assert.equal(f.saved.neverStarted.kind, 'never-started');
      assert.deepEqual(
        f.calls.map((x) => x.key),
        ['diagnostic', 'restore']
      );
      assert.equal(f.saved.stop, undefined);
      assert.equal(f.saved.drained, undefined);
      assert.equal(f.f.pool.scaling.manualInstanceCount, 0);
    } finally {
      Date.now = now;
    }
  });
for (const key of ['diagnostic', 'start', 'stop', 'restore'])
  test(`known ${key} LRO resume cannot replay a PATCH or reverify a superseded ancestor`, async () => {
    const f = await fixture(),
      save = f.options.save;
    let once = true;
    f.options.save = async (next) => {
      await save(next);
      if (once && next[key]?.stage === 'acknowledged') {
        once = false;
        throw new Error('CONTROLLED_CHECKPOINT_ACK_LOST');
      }
    };
    await assert.rejects(runMediaRecoveryCycle(f.options));
    const result = await runMediaRecoveryCycle({ ...f.options, saved: f.saved });
    assert.equal(result.stage, 'completed');
    assert.deepEqual(
      f.calls.map((x) => x.key),
      ['diagnostic', 'start', 'stop', 'restore']
    );
  });
for (const boundary of ['never-started', 'restore-acknowledged', 'restore-completed'])
  test(`no-start cleanup resumes at ${boundary} without allocating`, async () => {
    const f = await fixture(),
      api = f.options.api,
      save = f.options.save;
    let lostQuota = false,
      interrupted = false,
      startAttempts = 0;
    f.options.api = (...args) => {
      if (lostQuota && args[0].includes('cloudquotas')) throw new Error('CONTROLLED_QUOTA_LOSS');
      return api(...args);
    };
    f.options.save = async (next) => {
      if (next.start?.stage === 'attempted') startAttempts++;
      await save(next);
      if (next.diagnostic?.stage === 'completed' && !next.neverStarted) lostQuota = true;
      if (next.neverStarted) lostQuota = false;
      if (
        !interrupted &&
        (boundary === 'never-started'
          ? next.neverStarted && !next.restore
          : next.restore?.stage === boundary.slice('restore-'.length))
      ) {
        interrupted = true;
        throw new Error('CONTROLLED_CHECKPOINT_ACK_LOSS');
      }
    };
    await assert.rejects(runMediaRecoveryCycle(f.options));
    assert.equal(interrupted, true);
    await assert.rejects(runMediaRecoveryCycle({ ...f.options, saved: f.saved }));
    assert.equal(f.saved.stage, 'completed');
    assert.equal(startAttempts, 0);
    assert.deepEqual(
      f.calls.map((x) => x.key),
      ['diagnostic', 'restore']
    );
  });
test('native revision UID replacement at credential boundary denies scale', async () => {
  const f = await fixture(),
    save = f.options.save;
  f.options.save = async (next) => {
    await save(next);
    if (next.start?.stage === 'attempted') f.revisions.get(f.f.pool.latestReadyRevision).uid = 'foreign-revision-uid';
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic']
  );
});
test('new diagnostic revision must have a distinct native UID and exact image/template', async () => {
  for (const drift of ['uid', 'image']) {
    const f = await fixture(),
      api = f.options.api,
      original = f.revisions.get(f.f.pool.latestReadyRevision).uid;
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (args[1] === 'PATCH' && args[2].template) {
        const revision = f.revisions.get(f.f.pool.latestReadyRevision);
        if (drift === 'uid') revision.uid = original;
        else revision.containers[0].image = 'foreign';
      }
      return r;
    };
    await assert.rejects(runMediaRecoveryCycle(f.options));
    assert.deepEqual(
      f.calls.map((x) => x.key),
      ['diagnostic']
    );
  }
});
