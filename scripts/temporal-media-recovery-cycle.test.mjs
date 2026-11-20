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
test('canonical recovery cannot confirm exact provider instance exit from a zero count', async () => {
  await assert.rejects(
    canonicalMediaRecoveryRuntime.confirmStopped({ pool: { desiredManualInstanceCount: 0 } }),
    /MEDIA_RECOVERY_EXACT_INSTANCE_EXIT_UNCONFIRMED/
  );
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
test('protection drift during an acknowledged scale operation blocks completion and resumes by readback', async () => {
  const f = await fixture();
  const { api, observeProtection, runtime } = f.options;
  const execute = runtime.execute;
  let changed = false,
    injectDrift = true,
    executions = 0;
  f.options.api = async (...args) => {
    const value = await api(...args);
    const scale = f.saved?.start;
    if (injectDrift && scale?.stage === 'acknowledged' && args[0].endsWith(scale.nativeOperation) && value.done)
      changed = true;
    return value;
  };
  f.options.observeProtection = async (scope) => {
    if (changed && scope.phase === 'start') throw new Error('CONTROLLED_PROTECTION_DRIFT');
    return observeProtection(scope);
  };
  runtime.execute = async (scope) => {
    executions++;
    return execute(scope);
  };
  await assert.rejects(runMediaRecoveryCycle(f.options), /CONTROLLED_PROTECTION_DRIFT/);
  assert.equal(f.saved.start.stage, 'acknowledged');
  assert.equal(executions, 0);
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['diagnostic', 'start']
  );
  injectDrift = changed = false;
  const completed = await runMediaRecoveryCycle({ ...f.options, saved: f.saved });
  assert.equal(completed.stage, 'completed');
  assert.equal(executions, 1);
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['diagnostic', 'start', 'stop', 'restore']
  );
});
test('recovery failure still drains/stops/restores the exact owned diagnostic revision', async () => {
  const f = await fixture();
  f.options.runtime.execute = async ({ plan }) => ({
    kind: 'recovery-failed',
    operationId: plan.operationId,
    bindingDigest: plan.bindingDigest,
    buildId: plan.buildId,
    image: plan.image,
    proofSHA256: 'f'.repeat(64),
  });
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic', 'start', 'stop', 'restore']
  );
  assert.equal(f.saved.stage, 'completed');
  assert.equal(f.saved.recoveryFailed.kind, 'recovery-failed');
  await assert.rejects(runMediaRecoveryCycle({ ...f.options, saved: f.saved }));
});
test('an unavailable original outcome leaves the cycle resumable without a second scale-up', async () => {
  const f = await fixture();
  const confirmed = f.options.runtime.execute;
  f.options.runtime.execute = async () => {
    throw new Error('CONTROLLED_OBSERVATION_UNAVAILABLE');
  };
  await assert.rejects(runMediaRecoveryCycle(f.options), /CONTROLLED_OBSERVATION_UNAVAILABLE/);
  assert.equal(f.saved.stage, 'prepared');
  assert.equal(f.saved.recoveryFailed, undefined);
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['diagnostic', 'start']
  );
  f.options.runtime.execute = confirmed;
  const result = await runMediaRecoveryCycle({ ...f.options, saved: f.saved });
  assert.equal(result.stage, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['diagnostic', 'start', 'stop', 'restore']
  );
});
for (const when of ['before collection', 'during collection']) {
  test(`original recovery proof remains eligible when START authority expires ${when}`, async () => {
    const f = await fixture();
    const { save, runtime } = f.options;
    const originalNow = Date.now;
    let observed = 0;
    const expire = (plan) => {
      const afterExpiry = plan.expiresAt + 1;
      Date.now = () => afterExpiry;
    };
    f.options.save = async (state) => {
      await save(state);
      if (when === 'before collection' && state.start?.stage === 'completed') expire(state.plan);
    };
    runtime.execute = async (scope) => {
      observed++;
      if (when === 'during collection') expire(scope.plan);
      assert.ok(Date.now() > scope.plan.expiresAt);
      return {
        kind: 'recovery',
        operationId: scope.plan.operationId,
        bindingDigest: scope.plan.bindingDigest,
        buildId: scope.plan.buildId,
        image: scope.plan.image,
        proofSHA256: 'f'.repeat(64),
      };
    };
    try {
      const result = await runMediaRecoveryCycle(f.options);
      assert.equal(observed, 1);
      assert.equal(result.stage, 'completed');
      assert.equal(result.recovery.kind, 'recovery');
      assert.equal(result.recoveryFailed, undefined);
      assert.deepEqual(
        f.calls.map((call) => call.key),
        ['diagnostic', 'start', 'stop', 'restore']
      );
    } finally {
      Date.now = originalNow;
    }
  });
}
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

test('a 403 during the final authorization fence is not a rejected scale request', async () => {
  const f = await fixture();
  const api = f.options.api;
  let inFinalFence = false;
  f.options.authorizeMutation = async () => {
    if (inFinalFence) throw Object.assign(new Error('CONTROLLED_FENCE_READ_DENIED'), { status: 403 });
  };
  f.options.api = async (...args) => {
    if (args[1] === 'PATCH' && args[2].scaling?.manualInstanceCount === 1) {
      inFinalFence = true;
      try {
        await args[3]();
        assert.fail('The final fence must deny before the PATCH');
      } finally {
        inFinalFence = false;
      }
    }
    return api(...args);
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.equal(f.saved.start.stage, 'attempted');
  assert.equal(f.saved.neverStarted, undefined);
  assert.equal(f.saved.restore, undefined);
  assert.deepEqual(
    f.calls.map((x) => x.key),
    ['diagnostic']
  );
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

for (const failure of [undefined, 'wrong-execution', 'pool-drift']) {
  test(
    'Job path keeps the original zero pool and requires exact closure' + (failure ? ' / ' + failure : ''),
    async () => {
      const f = await fixture();
      const initial = structuredClone(f.f.pool);
      const seen = [];
      let launch;
      f.options.runtime.launchJob = async ({ plan, protect }) => {
        await protect();
        assert.equal(f.saved.stage, 'prepared');
        assert.equal(plan.job.template.template.maxRetries, 0);
        launch = {
          stage: 'acknowledged',
          jobPlanSHA256: hash(plan.job),
          jobUid: 'job-uid',
          execution: plan.job.name + '/executions/original',
          executionUid: 'original-execution-uid',
        };
        seen.push('launch');
        return { runIdentity: launch };
      };
      f.options.runtime.execute = async ({ plan, pool, jobRun }) => {
        assert.deepEqual(pool, plan.origin);
        assert.equal(pool.desiredManualInstanceCount, 0);
        assert.deepEqual(jobRun, launch);
        seen.push('recover-and-confirm');
        return {
          recovery: {
            kind: 'recovery',
            operationId: plan.operationId,
            bindingDigest: plan.bindingDigest,
            image: plan.image,
            buildId: plan.buildId,
            proofSHA256: '1'.repeat(64),
          },
          jobTermination: {
            kind: 'job-task-terminated',
            operationId: plan.operationId,
            job: plan.job.name,
            jobUid: launch.jobUid,
            execution: launch.execution,
            executionUid: failure === 'wrong-execution' ? 'unrelated' : launch.executionUid,
            proofSHA256: '2'.repeat(64),
          },
        };
      };
      f.options.runtime.drainJob = async ({ plan, jobTermination }) => {
        seen.push('drain');
        if (failure === 'pool-drift') f.f.pool.etag = 'foreign-etag';
        return {
          kind: 'job-queues-drained',
          operationId: plan.operationId,
          terminationSHA256: jobTermination.proofSHA256,
          observedAt: new Date().toISOString(),
          proofSHA256: '3'.repeat(64),
        };
      };
      if (failure) {
        await assert.rejects(runMediaRecoveryCycle(f.options), /CYCLE_UNCONFIRMED/);
        assert.equal(f.saved.stage, 'prepared');
      } else {
        const complete = await runMediaRecoveryCycle(f.options);
        assert.equal(complete.disposition, 'normal-zero-after-job');
        assert.deepEqual(seen, ['launch', 'recover-and-confirm', 'drain']);
        assert.deepEqual(f.f.pool, initial);
        assert.deepEqual(await runMediaRecoveryCycle({ ...f.options, saved: complete }), complete);
        assert.deepEqual(seen, ['launch', 'recover-and-confirm', 'drain']);
      }
      assert.deepEqual(f.calls, []);
    }
  );
}
