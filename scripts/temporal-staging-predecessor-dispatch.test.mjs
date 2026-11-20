import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStagingPredecessorDispatchWork, observeStagingPredecessorDispatch } from './temporal-staging-predecessor-dispatch.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames, renderServerlessDispatchService, renderServerlessDispatchWakeups } from './temporal-serverless-dispatch-resources.mjs';

const project = 'urm-app-staging', region = 'us-central1';
const buildId = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const successorBuildId = 'd'.repeat(40), uiCommit = 'a'.repeat(40);
const operationId = '7459ce36-f3e0-4861-b662-db2fe06236f1';
const releaseId = '417a472a-c79b-4c3b-bb85-f3d9e4d04696';
const image = 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:e405a820385a8d4f908debbcba2f030cea991db89bfc13877c04d03115f2cf12';
const parent = 'projects/urm-app-staging/locations/us-central1/backends/web-staging';

function fixture() {
  const workerRoles = ['controls', 'orchestration', 'media', 'search', 'images', 'email'];
  const names = dispatchResourceNames(buildId);
  const namespace = project + '.qwejt';
  const platform = {
    schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: project, cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: region,
    cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/evidence',
    firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images',
      databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: namespace, workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'e'.repeat(64),
    dispatch: { ...names, apiKeyVersion: '1' },
    roleBindings: workerRoles.map(role => ({ ...serverlessResourceNames(buildId, role), projectId: project,
      region, namespace, buildId, role, image, maxInstances: 1, stabilizationSeconds: 180 })),
  };
  const config = { projectId: project, region, buildId, image, apiKeyVersion: '1' };
  const body = renderServerlessDispatchService(config, 'disabled');
  body.annotations = { 'urm.upperroom.media/preparation': operationId };
  const rev = names.service + '/revisions/' + names.serviceId + '-00001-x';
  const service = { ...structuredClone(body), uid: 'service-uid', etag: 'service-etag', generation: '1', observedGeneration: '1',
    uri: 'https://' + names.serviceId + '-251680231116.us-central1.run.app', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: rev, latestCreatedRevision: rev, trafficStatuses: [{ revision: rev, percent: 100 }] };
  const revision = { ...structuredClone(body.template), name: rev, uid: 'revision-uid', etag: 'revision-etag', generation: '1',
    observedGeneration: '1', conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }] };
  const receipt = { releaseId, operationId, identityState: { stage: 'completed',
    nativeOperation: 'projects/urm-app-staging/locations/us-central1/operations/original',
    service: { name: names.service, uid: service.uid, generation: '1', revision: rev, revisionUid: revision.uid,
      admission: 'disabled', uri: service.uri },
    plan: { operationId, releaseId, role: 'dispatch', buildId, evidenceDigest: '4705617a0efd0b2cd8e1248ea0ea7814e736b225b29da8d3a6d07c03f1608585',
      apiKeyVersion: '1', runner: names.runnerServiceAccount, body },
  } };
  const savedBuild = parent.replace(project, '251680231116') + '/builds/temporal-52fa00c162ccc581dfb1';
  const state = { releaseId, controlRevision: 65, phase: 'provider-usage-ready', mode: 'durable-upgrade',
    compatibilityCommit: buildId, uiCommit: buildId, savedRolloutPolicy: { codebaseBranch: 'staging' },
    appHostingFreezeETag: 'before', appHostingFrozenETag: 'frozen', savedUiTraffic: { splits: [{ build: savedBuild, percent: 100 }] } };
  const traffic = { name: parent + '/traffic', etag: 'frozen', current: structuredClone(state.savedUiTraffic),
    rolloutPolicy: { codebaseBranch: 'staging', disabled: true, disabledTime: '2026-11-20T12:00:00Z' } };
  const work = { pending: 0, matching: null };
  const stamp = { seconds: 10, nanoseconds: 42, toDate: () => new Date(10_000) };
  const snapshot = { exists: true, data: () => receipt, createTime: stamp, updateTime: stamp };
  const db = {
    projectId: project, databaseId: '(default)', doc(path) {
      if (path === 'temporalYouTubeRenderHosts/staging') return { slot: true };
      assert.equal(path, '_control/temporalCloudDispatchServicePreparation-' + operationId);
      return { get: async () => snapshot };
    },
    collection: (name) => {
      const query = (filters = []) => ({
        where: (...f) => query([...filters, f]), count: () => ({ name, aggregate: true, filters }),
        limit: (limit) => ({ name, limit, filters }),
      });
      return query();
    },
    runTransaction(callback, options) { assert.deepEqual(options, { readOnly: true }); return callback(tx); },
  };
  const tx = { get: async ref => {
    if (ref.slot) return { exists: false };
    if (ref.aggregate) return { data: () => ({ count: ref.name === 'durableJobOutbox' && !ref.filters.length ? work.pending : 0 }) };
    const matching = ref.name === 'durableActivityExecutions' && ref.filters[0][2] === work.matching;
    return { size: matching ? 1 : 0, docs: matching ? [{ ref: { path: ref.name + '/execution' } }] : [] };
  } };
  const wake = renderServerlessDispatchWakeups(config, service);
  const absent = [...wake.triggers.map(t => 'https://eventarc.googleapis.com/v1/' + t.name),
    'https://cloudscheduler.googleapis.com/v1/' + wake.scheduler.name];
  const cloud = 'https://run.googleapis.com/v2/', host = 'https://firebaseapphosting.googleapis.com/v1beta/';
  const resources = new Map([
    [cloud + names.service, service], [cloud + rev, revision],
    [cloud + names.service + ':getIamPolicy?options.requestedPolicyVersion=3', { etag: 'policy', bindings: [] }],
    [host + parent + '/traffic', traffic],
    [host + savedBuild.replace('251680231116', project), { name: savedBuild, state: 'READY', source: { codebase: { hash: uiCommit } } }],
    [host + parent + '/rollouts?pageSize=100', { nextPageToken: 'next', rollouts: [{ name: parent + '/rollouts/first', state: 'FAILED' }] }],
    [host + parent + '/rollouts?pageSize=100&pageToken=next', { rollouts: [{ name: parent + '/rollouts/second', state: 'SUCCEEDED' }] }],
  ]);
  const calls = [];
  const api = async (url, method = 'GET', data, beforeSend) => {
    assert.equal(method, 'GET'); assert.equal(data, undefined); beforeSend?.();
    calls.push(url);
    if (resources.has(url)) return structuredClone(resources.get(url));
    assert.ok(absent.includes(url));
    throw Object.assign(new Error('missing wake'), { status: 404 });
  };
  return { db, tx, platform, state, api, successorBuildId, receipt, snapshot, calls, traffic, work, resources,
    service, revision, absent, host, cloud, names };
}

test('joins original inert service receipt, three named absent wake resources, frozen build/rollouts and idle leases', async () => {
  const f = fixture();
  const proof = await observeStagingPredecessorDispatch(f);
  assert.equal(proof.dispatch.identity.uid, f.service.uid);
  assert.equal(proof.dispatch.identity.admission, 'disabled');
  assert.equal(proof.dispatch.namedWakesAbsent.length, 3);
  assert.equal(proof.frozenUi.rolloutCount, 2);
  assert.equal(proof.frozenUi.uiCommit, uiCommit);
  assert.match(proof.privateWorkSHA256, /^[0-9a-f]{64}$/);
  assert.ok(f.absent.every(url => f.calls.includes(url)));
});

test('rejects recreated or enabled dispatcher, source drift, transferred traffic, extra direct grants, and existing named wakes', async () => {
  for (const change of [
    f => { f.service.uid = 'replacement'; }, f => { f.revision.uid = 'replacement'; },
    f => { f.service.scaling.minInstanceCount = 1; }, f => { f.service.trafficStatuses[0].percent = 99; },
    f => { f.revision.containers[0].env.find(x => x.name === 'TEMPORAL_DISPATCH_ADMISSION').value = 'enabled'; },
    f => { f.receipt.identityState.plan.evidenceDigest = '0'.repeat(64); },
    f => { f.snapshot.updateTime = { ...f.snapshot.createTime, nanoseconds: 99 }; },
    f => { f.resources.get(f.cloud + f.names.service + ':getIamPolicy?options.requestedPolicyVersion=3').bindings.push({ role: 'roles/run.invoker' }); },
    ...[0, 1, 2].map(index => f => { f.resources.set(f.absent[index], {}); }),
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(observeStagingPredecessorDispatch(f));
  }
});

test('requires native post-credential 404 for each absent wake', async () => {
  for (const [status, native] of [[403, true], [404, false], [503, true]]) {
    const f = fixture(), original = f.api;
    f.api = async (...args) => {
      if (args[0] === f.absent[0]) {
        if (native) args[3]();
        throw Object.assign(new Error('request failure'), { status });
      }
      return original(...args);
    };
    await assert.rejects(observeStagingPredecessorDispatch(f));
  }
});

test('rejects changed frozen traffic or etag, unverified builds, in-flight late-page rollout and missing pagination', async () => {
  const page = parent + '/rollouts?pageSize=100&pageToken=next';
  for (const change of [
    f => { f.traffic.etag = 'changed'; }, f => { f.traffic.rolloutPolicy.disabled = false; },
    f => { f.traffic.current.splits[0].build += '-changed'; }, f => { f.traffic.target = {}; },
    f => { f.resources.get(f.host + page).rollouts[0].state = 'IN_PROGRESS'; },
    f => { f.resources.get(f.host + page).nextPageToken = 'next'; },
    f => { f.resources.get(f.host + parent + '/builds/temporal-52fa00c162ccc581dfb1').source.codebase.hash = buildId; },
    f => { f.resources.get(f.host + parent + '/builds/temporal-52fa00c162ccc581dfb1').state = 'BUILDING'; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(observeStagingPredecessorDispatch(f));
  }
});

test('transaction-time work check rejects a pending outbox or a durable record on either build', async () => {
  for (const change of [f => { f.work.pending = 1; }, f => { f.work.matching = buildId; },
    f => { f.work.matching = successorBuildId; }, f => { f.db.projectId = 'urm-app'; }]) {
    const f = fixture(); change(f);
    await assert.rejects(assertStagingPredecessorDispatchWork(f.db, f.tx, f.successorBuildId));
  }
});
