import assert from 'node:assert/strict';
import test from 'node:test';
import { observeStagingPredecessorPool } from './temporal-staging-predecessor-pool.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

const buildId = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const operationId = '842f1974-4e17-41c6-b2e0-51891326dbd1';
const apiBase = 'https://run.googleapis.com/v2/';
const latest = 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST';

function fixture() {
  const binding = {
    ...serverlessResourceNames(buildId, 'media'), buildId, role: 'media', projectId: 'urm-app-staging',
    region: 'us-central1', namespace: 'urm-app-staging.qwejt', maxInstances: 1, stabilizationSeconds: 180,
    image: 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:e405a820385a8d4f908debbcba2f030cea991db89bfc13877c04d03115f2cf12',
  };
  const body = renderServerlessWorkerPool(binding, { apiKeyVersion: '1', runtimeSecrets: [] });
  body.annotations = { 'urm.upperroom.media/preparation': operationId };
  const plan = {
    schemaVersion: 1, operationId, releaseId: '417a472a-c79b-4c3b-bb85-f3d9e4d04696', buildId,
    evidenceDigest: '4705617a0efd0b2cd8e1248ea0ea7814e736b225b29da8d3a6d07c03f1608585',
    identityReceiptSHA256: 'e816c19a45f4f6fea009fe2792b6a4893369dfba7d8ea10f0b4bce57dd5fb677',
    runner: binding.runnerServiceAccount, role: 'media', body,
  };
  const name = body.name.replace('projects/urm-app-staging/', 'projects/251680231116/');
  const revisionName = name + '/revisions/' + binding.poolName + '.1';
  const pool = {
    ...structuredClone(body), name, uid: 'pool-original', etag: 'pool-etag', generation: '1', observedGeneration: '1',
    scaling: { scalingMode: 'MANUAL' }, latestCreatedRevision: revisionName, latestReadyRevision: revisionName,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    instanceSplits: [{ type: latest, percent: 100 }],
    instanceSplitStatuses: [{ type: latest, revision: revisionName, percent: 100 }],
  };
  const revision = {
    ...structuredClone(body.template), name: revisionName, uid: 'revision-original', etag: 'revision-etag',
    generation: '1', observedGeneration: '1', conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
  };
  const calls = [];
  const api = async (url, method, data, beforeSend) => {
    assert.equal(method, 'GET');
    assert.equal(data, undefined);
    beforeSend?.();
    calls.push(url);
    if (url === apiBase + body.name) return structuredClone(pool);
    assert.equal(url, apiBase + body.name + '/revisions/' + binding.poolName + '.1');
    return structuredClone(revision);
  };
  return { plan, pool, revision, calls, api };
}

test('native 404 records only the observation and preserves the unknown create outcome', async () => {
  const { plan } = fixture();
  let reads = 0;
  const api = async (url, method, body, beforeSend) => {
    assert.equal(url, apiBase + plan.body.name);
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    reads++;
    beforeSend();
    throw Object.assign(new Error('absent'), { status: 404 });
  };
  const result = await observeStagingPredecessorPool({ plan, api });
  assert.equal(result.state, 'absent');
  assert.equal(result.createDisposition, 'unknown');
  assert.equal(reads, 1);
});

test('credentials and all other HTTP errors retain custody', async () => {
  const { plan } = fixture();
  for (const [sent, status] of [[false, 404], [true, 401], [true, 403], [true, 429], [true, 503], [true, undefined]]) {
    const api = async (_url, _method, _data, beforeSend) => {
      if (sent) beforeSend();
      throw Object.assign(new Error('read failed'), { status });
    };
    await assert.rejects(observeStagingPredecessorPool({ plan, api }));
  }
});

test('exact late pool and revision give a desired-zero observation under the original unknown attempt', async () => {
  for (const implicitSplit of [false, true]) {
    const f = fixture();
    if (implicitSplit) delete f.pool.instanceSplits;
    const observed = await observeStagingPredecessorPool(f);
    assert.equal(observed.state, 'matching-manual-zero');
    assert.equal(observed.createDisposition, 'unknown');
    assert.equal(observed.pool.desiredManualInstanceCount, 0);
    assert.equal(observed.revisionUid, f.revision.uid);
    assert.equal(observed.revisionEtag, f.revision.etag);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[0], f.calls[2]);
  }
});

test('changes to the original plan fail before HTTP, including changes that could redirect the GET', async () => {
  for (const change of [
    p => { p.body.name += '-replacement'; },
    p => { p.runner += '.other'; },
    p => { p.operationId = p.releaseId; },
    p => { p.body.template.volumes[1].emptyDir.sizeLimit = '64Gi'; },
    p => { p.body.scaling.manualInstanceCount = 1; },
  ]) {
    const f = fixture();
    change(f.plan);
    await assert.rejects(observeStagingPredecessorPool(f));
    assert.deepEqual(f.calls, []);
  }
});

test('unsettled or different pools, allocations and revisions cannot be accepted', async () => {
  for (const change of [
    f => { f.pool.reconciling = true; }, f => { f.pool.generation = f.pool.observedGeneration = '2'; },
    f => { f.pool.annotations = {}; }, f => { f.pool.scaling.manualInstanceCount = 1; },
    f => { f.pool.scaling.scalingMode = 'AUTOMATIC'; }, f => { delete f.pool.scaling.scalingMode; },
    f => { f.pool.scaling.minInstanceCount = 1; }, f => { f.pool.template.serviceAccount = 'other'; },
    f => { f.pool.template.containers[0].args = ['different']; },
    f => { f.pool.template.volumes[1].emptyDir.sizeLimit = '64Gi'; },
    f => { f.pool.instanceSplits[0].type = 'INSTANCE_SPLIT_ALLOCATION_TYPE_REVISION'; },
    f => { f.pool.instanceSplits[0].percent = 50; }, f => { f.pool.instanceSplitStatuses = []; },
    f => { f.pool.instanceSplitStatuses[0].revision += '-other'; },
    f => { f.pool.latestCreatedRevision = f.pool.latestReadyRevision = 'https://example.invalid/revision'; },
    f => { f.revision.containers[0].image += '-unverified'; }, f => { f.revision.name += '-other'; },
    f => { f.revision.uid = f.pool.uid; }, f => { delete f.revision.etag; },
    f => { f.revision.scaling = { minInstanceCount: 1 }; }, f => { f.revision.conditions = []; },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(observeStagingPredecessorPool(f));
  }
});

test('revision absence or pool drift between exact reads cannot become an absence receipt', async () => {
  for (const failure of ['revision-absent', 'pool-disappeared', 'pool-replaced', 'pool-etag']) {
    const f = fixture();
    const api = async (...args) => {
      const result = await f.api(...args);
      if ((f.calls.length === 2 && failure === 'revision-absent') ||
        (f.calls.length === 3 && failure === 'pool-disappeared')) throw Object.assign(new Error('absent'), { status: 404 });
      if (f.calls.length === 3 && failure === 'pool-replaced') result.uid = 'different';
      if (f.calls.length === 3 && failure === 'pool-etag') result.etag = 'different';
      return result;
    };
    await assert.rejects(observeStagingPredecessorPool({ plan: f.plan, api }));
  }
});
