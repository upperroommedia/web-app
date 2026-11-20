import assert from 'node:assert/strict';
import test from 'node:test';
import { cycleFixture } from './tests/fixtures/temporal-dispatch-cycle.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';
import {
  assertStagingDispatchWakes,
  enableStagingDispatchWakes,
  readStagingDispatchWakeAuthority,
} from './temporal-enable-dispatch-wakes.mjs';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';

async function fixture() {
  const { options: optionsBefore } = await cycleFixture();
  const options = { ...optionsBefore, operationId: '44444444-2222-4333-8444-555555555555' };
  const id = optionsBefore.operationId;
  const original = dispatchWakePlan({ ...optionsBefore, surface: 'scheduler' });
  const job = { ...original.body, userUpdateTime: new Date().toISOString(), state: 'PAUSED' };
  const resource = { name: job.name, userUpdateTime: job.userUpdateTime };
  const schedulerCreation = {
    operationId: id,
    releaseId: options.releaseId,
    bindingDigest: 'f'.repeat(64),
    identityState: { stage: 'completed', plan: original, resource, acknowledgedResource: resource },
  };
  const revision = 'controlled-service-revision';
  const diagnostic = {
    operationId: id,
    releaseId: options.releaseId,
    bindingDigest: schedulerCreation.bindingDigest,
    buildId: options.platform.workerBuildId,
    image: options.platform.workerImage,
    evidenceDigest: options.evidenceDigest,
    observations: [{ serviceRevision: revision }],
    wakes: [{ surface: 'scheduler', creation: { dataDigest: proofDigest(schedulerCreation) } }],
  };
  let saved,
    resumes = 0,
    creates = 0,
    lose = '',
    authority = true;
  const rows = new Map(),
    operations = new Map();
  const parent = 'projects/urm-app-staging/locations/us-central1';
  const verify = async () => {
    if (!authority) throw Error('paused authority changed');
  };
  Object.assign(options, {
    diagnostic,
    schedulerCreation,
    verify,
    assertAuthority: verify,
    save: async (next) => {
      saved = structuredClone(next);
    },
    verifyConfiguration: async () => ({
      buildId: options.platform.workerBuildId,
      service: { revision, uid: 'service-uid', revisionUid: 'revision-uid', image: options.platform.workerImage },
      scheduler: {
        name: job.name,
        userUpdateTime: job.userUpdateTime,
        configurationDigestVersion: 2,
        configurationSHA256: proofDigest(job),
      },
      triggers: [...rows.values()].map(({ name, uid }) => ({ name, uid })),
    }),
    api: async (url, method = 'GET', body, beforeSend) => {
      if (beforeSend) await beforeSend();
      if (new URL(url).origin === 'https://logging.googleapis.com') {
        const [response] = operations.values();
        const name = [...operations.keys()][0];
        return {
          entries: [
            {
              insertId: 'causal-original',
              timestamp: saved.wakes['outbox-trigger'].attemptedAt,
              logName: 'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Fdata_access',
              operation: { id: name, producer: 'eventarc.googleapis.com', first: true },
              protoPayload: {
                serviceName: 'eventarc.googleapis.com',
                methodName: 'google.cloud.eventarc.v1.Eventarc.CreateTrigger',
                authenticationInfo: { principalEmail: options.creator },
                resourceName: parent,
                request: { parent, triggerId: response.name.split('/').at(-1), trigger: saved.plan.triggers[0].body },
                response: { name },
              },
            },
          ],
        };
      }
      if (url.endsWith(':resume')) {
        assert.equal(method, 'POST');
        assert.equal(body, undefined);
        assert.equal(job.state, 'PAUSED');
        assert.equal(saved.scheduler.stage, 'attempted');
        assert.ok(beforeSend);
        resumes++;
        job.state = 'ENABLED';
        if (lose === 'resume') throw Error('controlled Scheduler ACK loss');
        return structuredClone(job);
      }
      if (url.endsWith(job.name)) return structuredClone(job);
      if (method === 'POST') {
        assert.ok(beforeSend);
        const trigger = saved.plan.triggers.find((item) => item.body.name === body.name);
        assert.equal(saved.wakes[trigger.surface].stage, 'attempted');
        const name = `${parent}/operations/create-${++creates}`;
        const row = { ...body, uid: `uid-${creates}`, etag: `etag-${creates}` };
        rows.set(row.name, row);
        operations.set(name, row);
        if (lose === 'create' && creates === 1) throw Error('controlled Eventarc ACK loss');
        return { name };
      }
      const name = url.replace('https://eventarc.googleapis.com/v1/', '');
      if (operations.has(name)) return { name, done: true, response: structuredClone(operations.get(name)) };
      if (rows.has(name)) return structuredClone(rows.get(name));
      throw Object.assign(Error('absent'), { status: 404 });
    },
  });
  return {
    options,
    rows,
    job,
    set lose(value) {
      lose = value;
    },
    set authority(value) {
      authority = value;
    },
    get saved() {
      return saved;
    },
    get creates() {
      return creates;
    },
    get resumes() {
      return resumes;
    },
    run: () => enableStagingDispatchWakes({ ...options, saved }),
  };
}

test('retains both business triggers and resumes the diagnostic Scheduler identity once', async () => {
  const f = await fixture();
  const done = await f.run();
  assert.equal(done.stage, 'completed');
  assert.equal(done.scheduler.outcome, 'acknowledged-and-observed');
  assert.equal(f.creates, 2);
  assert.equal(f.resumes, 1);
  assert.deepEqual(await f.run(), done);
  assert.equal(f.creates, 2);
  assert.equal(f.resumes, 1);
});

test('lost Eventarc create and Scheduler resume ACKs reconcile without duplicate writes', async () => {
  const f = await fixture();
  f.lose = 'create';
  await assert.rejects(f.run(), /Eventarc ACK loss/);
  assert.equal(f.saved.wakes['outbox-trigger'].stage, 'attempted');
  f.lose = 'resume';
  await assert.rejects(f.run(), /Scheduler ACK loss/);
  assert.equal(f.saved.wakes['outbox-trigger'].audit.insertId, 'causal-original');
  assert.equal(f.saved.scheduler.stage, 'attempted');
  const done = await f.run();
  assert.equal(done.scheduler.outcome, 'enabled-observed-after-unknown-ack');
  assert.equal(f.creates, 2);
  assert.equal(f.resumes, 1);
});

test('foreign scheduler identity, unowned existing trigger and revoked authority fail closed', async () => {
  const foreign = await fixture();
  foreign.job.userUpdateTime = new Date(Date.now() + 1000).toISOString();
  await assert.rejects(foreign.run());
  assert.equal(foreign.creates, 0);
  const occupied = await fixture();
  const { body } = dispatchWakePlan({ ...occupied.options, surface: 'outbox-trigger' });
  occupied.rows.set(body.name, { ...body, uid: 'unowned' });
  await assert.rejects(occupied.run());
  assert.equal(occupied.creates, 0);
  const revoked = await fixture();
  const save = revoked.options.save;
  revoked.options.save = async (next) => {
    await save(next);
    if (next.wakes['outbox-trigger']) revoked.authority = false;
  };
  await assert.rejects(revoked.run(), /authority changed/);
  assert.equal(revoked.creates, 0);
});

test('readiness denies a replacement Scheduler job or either unowned trigger', async () => {
  const f = await fixture();
  const identityState = await f.run();
  const { platform, evidenceDigest, operationId, releaseId } = f.options;
  const live = await f.options.verifyConfiguration();
  const context = { platform, evidenceDigest, operationId, releaseId, live };
  const receipt = { operationId, releaseId, identityState };
  assert.doesNotThrow(() => assertStagingDispatchWakes(receipt, context));
  live.triggers[0].uid = 'different-trigger';
  assert.throws(() => assertStagingDispatchWakes(receipt, context), /UNCONFIRMED/);
  live.triggers = identityState.configuration.triggers;
  const originalScheduler = live.scheduler.configurationSHA256;
  live.scheduler.configurationSHA256 = proofDigest({ changedOwnershipMarker: true });
  assert.throws(() => assertStagingDispatchWakes(receipt, context), /UNCONFIRMED/);
  live.scheduler.configurationSHA256 = originalScheduler;
  live.scheduler.userUpdateTime = new Date(Date.now() + 1000).toISOString();
  assert.throws(() => assertStagingDispatchWakes(receipt, context), /UNCONFIRMED/);
});

test('readiness requires the same immutable diagnostic and dispatch revision activation', async () => {
  const f = await fixture();
  const { platform, evidenceDigest, operationId, releaseId, diagnostic } = f.options;
  const stage = await f.run();
  const live = await f.options.verifyConfiguration();
  const activationOperationId = '55555555-2222-4333-8444-555555555555';
  const wakePath = `_control/temporalCloudBusinessDispatchWakes-${operationId}`;
  const diagPath = `_control/temporalDispatchDiagnosticCompletion-${diagnostic.operationId}`;
  const activationPath = `_control/temporalCloudDispatchActivation-${activationOperationId}`;
  const docs = new Map();
  const written = new Map();
  const stamp = (seconds) => ({
    seconds,
    nanoseconds: 0,
    toDate: () => new Date(seconds * 1000),
    isEqual: (other) => other?.seconds === seconds,
  });
  const snapshot = (ref) => {
    const data = docs.get(ref.path);
    const version = written.get(ref.path) ?? 1;
    return {
      ref,
      exists: data !== undefined,
      data: () => structuredClone(data),
      get: (key) => key.split('.').reduce((value, field) => value?.[field], data),
      createTime: stamp(version),
      updateTime: stamp(version),
    };
  };
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path }),
    runTransaction: async (run, options) => {
      assert.deepEqual(options, { readOnly: true });
      return run({ get: async (ref) => snapshot(ref) });
    },
  };
  docs.set(activationPath, {
    releaseId,
    operationId: activationOperationId,
    identityState: { stage: 'completed', plan: { evidenceDigest }, service: { revision: live.service.revision } },
  });
  const original = {
    ...diagnostic,
    schemaVersion: 1,
    activationOperationId,
    activation: nativeSnapshotProof(snapshot(db.doc(activationPath))),
    scope: 'original diagnostic delivery, retry reconciliation and resource cleanup only',
    observations: Array.from({ length: 3 }, () => ({ serviceRevision: live.service.revision })),
  };
  docs.set(diagPath, original);
  docs.set(wakePath, {
    operationId,
    releaseId,
    identityState: { ...stage, plan: { ...stage.plan, diagnosticSHA256: proofDigest(original) } },
  });
  const read = (tx) =>
    readStagingDispatchWakeAuthority(db, { platform, evidenceDigest, operationId, releaseId, live }, tx);
  assert.deepEqual(
    (await read()).map((item) => item.path),
    [wakePath, diagPath, activationPath]
  );
  const sameReleaseTransaction = { get: async (ref) => snapshot(ref) };
  const originalTransaction = db.runTransaction;
  db.runTransaction = () => {
    throw new Error('Unexpected nested transaction');
  };
  try {
    assert.deepEqual(
      (await read(sameReleaseTransaction)).map((item) => item.path),
      [wakePath, diagPath, activationPath]
    );
  } finally {
    db.runTransaction = originalTransaction;
  }
  docs.delete(diagPath);
  await assert.rejects(read(sameReleaseTransaction), /UNCONFIRMED/);
  await assert.rejects(read, /UNCONFIRMED/);
  docs.set(diagPath, { ...original, manifestSHA256: 'c'.repeat(64) });
  await assert.rejects(read, /UNCONFIRMED/);
  docs.set(diagPath, original);
  written.set(activationPath, 2);
  await assert.rejects(read, /AUTHORITY_CHANGED/);
});

test('a completed wake activation rereads its pinned Scheduler config without issuing a new wake', async () => {
  const f = await fixture();
  await f.run();
  const verify = f.options.verifyConfiguration;
  f.options.verifyConfiguration = async () => {
    const live = await verify();
    live.scheduler.configurationSHA256 = proofDigest({ foreign: true });
    return live;
  };
  await assert.rejects(f.run(), /UNCONFIRMED/);
  assert.equal(f.resumes, 1);
  assert.equal(f.creates, 2);
});
