import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_PATH, RELEASE_DOMAINS } from './temporal-release-lib.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
import { settleRejectedPoolCreation } from './temporal-settle-staging-pool-create-rejection.mjs';

const projectId = 'urm-app-staging';
const operationId = 'd8cbf798-77f6-4af3-b429-cd2eddadc7de';
const releaseId = '417a472a-c79b-4c3b-bb85-f3d9e4d04696';
const buildId = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const parent = `projects/${projectId}/locations/us-central1`;
const target = `${parent}/workerPools/urm-worker-controls-b008afa426291ad2aa94`;
const lockPath = '_control/temporalReleaseOperation';
const markerPath = '_control/temporalProviderUsage';
const failurePath = `_control/temporalCloudPoolCreateRejection-${operationId}`;
const successPath = `_control/temporalCloudPoolPreparation-${operationId}`;
const rejectedStatus = {
  code: 3,
  message: 'Violation in CreateWorkerPoolRequest.worker_pool: worker_pool.name must be empty on CreateWorkerPoolRequest.',
};

class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this._seconds = seconds;
    this._nanoseconds = nanoseconds;
  }
  get seconds() { return this._seconds; }
  get nanoseconds() { return this._nanoseconds; }
  toDate() { return new Date(this.seconds * 1000); }
}

function fixture({ doubt = false, drift = false, status = 404, mutateAudit, preexistingSuccess = false } = {}) {
  const operator = {
    email: 'operator@example.test', adcAndGcloudAccountMatch: true,
    operatorCommit: 'a'.repeat(40), operatorClosureDigest: 'b'.repeat(64),
  };
  const operatorIdentity = { runtimeCommit: buildId };
  const createTime = new Timestamp(100, 3);
  const updateTime = new Timestamp(101, 4);
  const settledTime = new Timestamp(Math.ceil(Date.now() / 1000) + 1, 5);
  const poolBody = {
    name: target,
    annotations: { 'urm.upperroom.media/preparation': operationId },
    template: {
      containers: [{ env: [{ name: 'KEY', value: 'retained-in-checkpoint' }] }],
      volumes: [{ secret: { items: [{ path: 'key-file', version: '1' }] } }],
    },
  };
  const projectedBody = structuredClone(poolBody);
  delete projectedBody.template.containers[0].env;
  delete projectedBody.template.volumes[0].secret.items[0].path;
  const entry = {
    insertId: '17llmkzd434g',
    timestamp: '2026-11-20T12:05:42.132901Z',
    logName: `projects/${projectId}/logs/cloudaudit.googleapis.com%2Factivity`,
    protoPayload: {
      serviceName: 'run.googleapis.com',
      methodName: 'google.cloud.run.v2.WorkerPools.CreateWorkerPool',
      resourceName: target,
      authenticationInfo: { principalEmail: operator.email },
      status: rejectedStatus,
      request: { '@type': 'type.googleapis.com/google.cloud.run.v2.CreateWorkerPoolRequest', parent, workerPool: projectedBody },
    },
  };
  const documents = new Map(Object.entries({
    [lockPath]: {
      operationId, releaseId, action: 'prepare-cloud-run-pool', operatorIdentity,
      operatorPrincipal: operator, bindingDigest: proofDigest(operatorIdentity),
      cloudPoolPreparation: {
        stage: 'attempted', attemptedAt: '2026-11-20T12:05:37.367Z',
        plan: { operationId, releaseId, role: 'controls', buildId, body: poolBody },
      },
    },
    [CONTROL_PATH]: {
      releaseId, revision: 65, admission: 'paused',
      domains: Object.fromEntries(RELEASE_DOMAINS.map((domain) => [domain, { admission: 'paused' }])),
    },
    '_control/temporalReleaseState': {
      releaseId, controlRevision: 65, phase: 'provider-usage-ready', providerUsageEpoch: 'epoch', compatibilityCommit: buildId,
    },
    [markerPath]: { projectId, epoch: 'epoch' },
  }).map(([path, data]) => [path, { createTime, updateTime, data }]));
  const checkpoint = JSON.parse(JSON.stringify(Object.fromEntries(documents)));
  if (preexistingSuccess) documents.set(successPath, { createTime, updateTime, data: { unexpected: true } });
  const calls = [];
  const operations = [];
  const getAll = async (...refs) => refs.map((ref) => ({
    exists: documents.has(ref.path),
    createTime: documents.get(ref.path)?.createTime,
    updateTime: documents.get(ref.path)?.updateTime,
    data: () => documents.get(ref.path)?.data,
  }));
  const firestore = {
    doc: (path) => ({ path }),
    getAll,
    async runTransaction(callback, options) {
      assert.deepEqual(options, { maxAttempts: 1 });
      operations.push('transaction');
      if (drift) documents.get(markerPath).updateTime = settledTime;
      const effects = [];
      await callback({
        getAll,
        create(ref, data) {
          assert.equal(ref.path, failurePath);
          effects.push(() => documents.set(ref.path, { createTime: settledTime, updateTime: settledTime, data }));
          operations.push('create');
        },
        delete(ref, precondition) {
          assert.equal(ref.path, lockPath);
          assert.deepEqual(precondition, { lastUpdateTime: updateTime });
          effects.push(() => documents.delete(ref.path));
          operations.push('delete');
        },
      });
      effects.forEach((apply) => apply());
      if (doubt) throw new Error('lost acknowledgement');
    },
  };
  const api = async (url, method = 'GET', body) => {
    calls.push({ url, method });
    if (url === 'https://logging.googleapis.com/v2/entries:list') {
      assert.equal(method, 'POST');
      assert.deepEqual(body.resourceNames, [`projects/${projectId}`]);
      assert.ok(body.filter.includes(target));
      const page = { entries: [structuredClone(entry)] };
      mutateAudit?.(page);
      return page;
    }
    assert.equal(method, 'GET');
    assert.equal(url, `https://run.googleapis.com/v2/${target}`);
    if (status === 200) return { name: target };
    throw Object.assign(new Error('native result'), { status });
  };
  return {
    inputs: { firestore, api, checkpoint, originalAudit: [entry], operator, serverTimestamp: () => settledTime },
    calls, operations, documents,
  };
}

test('inspection joins original rejected native request and exact absence without writing', async () => {
  const f = fixture();
  const result = await settleRejectedPoolCreation({ ...f.inputs, apply: false });
  assert.equal(result.mode, 'inspect');
  assert.deepEqual(f.calls.map(({ method }) => method), ['POST', 'GET']);
  assert.deepEqual(f.operations, []);
  assert.ok(f.documents.has(lockPath));
});

test('one transaction retains the original attempt and releases only its native lock', async () => {
  const f = fixture();
  await settleRejectedPoolCreation({ ...f.inputs, apply: true });
  assert.deepEqual(f.operations, ['transaction', 'create', 'delete']);
  assert.equal(f.documents.has(lockPath), false);
  assert.equal(f.documents.get(failurePath).data.originalAttempt.cloudPoolPreparation.stage, 'attempted');
  assert.equal(f.documents.get(failurePath).data.poolWrites, 0);
  assert.equal(f.documents.get(failurePath).data.releaseStateWrites, 0);
});

test('lost commit acknowledgement only reads back the immutable result', async () => {
  const f = fixture({ doubt: true });
  const result = await settleRejectedPoolCreation({ ...f.inputs, apply: true });
  assert.equal(result.operationReleased, true);
  assert.deepEqual(f.operations, ['transaction', 'create', 'delete']);
  const reconciled = await settleRejectedPoolCreation({ ...f.inputs, apply: true });
  assert.equal(reconciled.mode, 'reconciled');
  assert.deepEqual(f.operations, ['transaction', 'create', 'delete']);
});

test('read-only reconciliation denies rewritten or foreign settlement evidence', async () => {
  for (const mutate of [
    (archive) => { archive.updateTime = new Timestamp(archive.createTime.seconds + 1); },
    (archive) => { archive.data.settlementOperator.operatorCommit = 'd'.repeat(40); },
    (archive) => { archive.data.authority[lockPath].updateTime.nanoseconds += 1; },
  ]) {
    const f = fixture();
    await settleRejectedPoolCreation({ ...f.inputs, apply: true });
    mutate(f.documents.get(failurePath));
    await assert.rejects(settleRejectedPoolCreation({ ...f.inputs, apply: true }));
    assert.deepEqual(f.operations, ['transaction', 'create', 'delete']);
  }
});

test('native provider marker timestamp drift retains original operation', async () => {
  const f = fixture({ drift: true });
  await assert.rejects(settleRejectedPoolCreation({ ...f.inputs, apply: true }));
  assert.deepEqual(f.operations, ['transaction']);
  assert.ok(f.documents.has(lockPath));
  assert.equal(f.documents.has(failurePath), false);
});

test('foreign, incomplete, or ambiguous provider evidence denies closure before the transaction', async () => {
  for (const options of [
    { status: 200 },
    { status: 403 },
    { preexistingSuccess: true },
    { mutateAudit: (page) => { page.nextPageToken = 'next'; } },
    { mutateAudit: (page) => { page.entries.push(page.entries[0]); } },
    { mutateAudit: (page) => { page.entries[0].protoPayload.status.code = 14; } },
    { mutateAudit: (page) => { page.entries[0].protoPayload.request.workerPool.annotations = {}; } },
    { mutateAudit: (page) => { page.entries[0].operation = {}; } },
  ]) {
    const f = fixture(options);
    await assert.rejects(settleRejectedPoolCreation({ ...f.inputs, apply: true }));
    assert.deepEqual(f.operations, []);
    assert.ok(f.documents.has(lockPath));
  }
});
