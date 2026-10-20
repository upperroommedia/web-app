import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloudRunDispatchConfiguration } from './temporal-release-dispatch.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import {
  dispatchResourceNames,
  renderServerlessDispatchService,
  renderServerlessDispatchWakeups,
} from './temporal-serverless-dispatch-resources.mjs';
const buildId = 'a'.repeat(40),
  image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function profile() {
  const workerRoles = ['orchestration', 'controls', 'email', 'search'];
  return {
    schemaVersion: 1,
    environment: 'staging',
    workerHosting: 'cloud-run',
    connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging',
    firebaseResources: {
      storageBucket: 'urm-app-staging.firebasestorage.app',
      imagesBucket: 'urm-app-staging-images',
      databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
    },
    temporalNamespace: 'urm-app-staging.qwejt',
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
    cloudAddress: 'us-central1.gcp.api.temporal.io:7233',
    cloudReplicaRegions: [],
    cloudEvidence: '/private/tmp/cloud-evidence.json',
    workerBuildId: buildId,
    workerImage: image,
    workerRoles,
    dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-api-key',
    operatorApiKeySHA256: 'c'.repeat(64),
    dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '7' },
    roleBindings: workerRoles.map((role) => ({
      projectId: 'urm-app-staging',
      region: 'us-central1',
      namespace: 'urm-app-staging.qwejt',
      buildId,
      role,
      ...serverlessResourceNames(buildId, role),
      image,
      maxInstances: 1,
      stabilizationSeconds: 180,
    })),
  };
}

function fixture() {
  const platform = profile();
  const config = {
    projectId: platform.firebaseProjectId,
    region: 'us-central1',
    buildId,
    image,
    apiKeyVersion: platform.dispatch.apiKeyVersion,
  };
  const service = renderServerlessDispatchService(config, 'enabled');
  Object.assign(service, {
    uid: 'service-uid',
    etag: 'service-etag',
    generation: '2',
    observedGeneration: '2',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    conditions: [{ type: 'RoutesReady', state: 'CONDITION_SUCCEEDED' }],
    uri: `https://${platform.dispatch.serviceId}-251680231116.us-central1.run.app`,
    latestCreatedRevision: `${service.name}/revisions/${platform.dispatch.serviceId}-00001-abc`,
    latestReadyRevision: `${service.name}/revisions/${platform.dispatch.serviceId}-00001-abc`,
  });
  service.trafficStatuses = [{ revision: service.latestReadyRevision.split('/').at(-1), percent: 100 }];
  const revision = {
    ...structuredClone(service.template),
    name: service.latestReadyRevision,
    uid: 'revision-uid',
    etag: 'revision-etag',
    generation: '1',
    observedGeneration: '1',
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
  };
  const wake = renderServerlessDispatchWakeups(config, service);
  const triggers = wake.triggers.map((trigger, i) => ({
    ...trigger,
    uid: `trigger-${i}`,
    etag: `etag-${i}`,
    transport: {
      pubsub: {
        topic: `projects/urm-app-staging/topics/topic-${i}`,
        subscription: `projects/urm-app-staging/subscriptions/sub-${i}`,
      },
    },
  }));
  const scheduler = { ...wake.scheduler, state: 'ENABLED' };
  const policy = {
    etag: 'policy-etag',
    bindings: [{ role: wake.serviceInvokerGrant.role, members: wake.serviceInvokerGrant.members }],
  };
  const calls = [];
  const api = async (url, method = 'GET', body) => {
    calls.push({ url, method, body });
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    if (url.includes(':getIamPolicy')) return policy;
    if (url.endsWith(revision.name)) return revision;
    if (url.endsWith(service.name)) return service;
    for (const trigger of triggers) if (url.endsWith(trigger.name)) return trigger;
    if (url.endsWith(scheduler.name)) return scheduler;
    throw new Error('Unexpected native endpoint');
  };
  return { platform, service, revision, triggers, scheduler, policy, api, calls };
}
test('joins private dispatch serving revision, zero-minimum settings, native wake configuration and direct IAM', async () => {
  const f = fixture();
  const proof = await verifyCloudRunDispatchConfiguration(f.platform, f.api);
  assert.equal(proof.buildId, buildId);
  assert.equal(proof.triggers.length, 2);
  assert.equal(proof.service.revisionUid, 'revision-uid');
  assert.equal(f.calls.length, 6);
  assert.match(proof.scope, /delivery and effective access unproved/);
  assert.equal(JSON.stringify(proof).includes('SMTP'), false);
});
for (const concern of [
  'reconciling',
  'failed-terminal',
  'generation',
  'deleted',
  'wrong-image',
  'worker-entrypoint',
  'mixed-traffic',
  'revision-path',
  'always-on',
  'service-floor',
  'manual-scale',
  'unbilled-cpu',
  'wrong-secret',
  'foreign-source',
  'trigger-error',
  'no-retries',
  'foreign-transport',
  'paused-scheduler',
  'wrong-audience',
  'static-auth',
  'public-invoker',
  'conditional-invoker',
  'duplicate-env',
  'private-api-error',
])
  test(`dispatch configuration rejects ${concern}`, async () => {
    const f = fixture();
    if (concern === 'reconciling') f.service.reconciling = true;
    if (concern === 'failed-terminal') f.service.terminalCondition.state = 'CONDITION_FAILED';
    if (concern === 'generation') f.service.observedGeneration = '1';
    if (concern === 'deleted') f.revision.deleteTime = new Date().toISOString();
    if (concern === 'wrong-image') f.revision.containers[0].image = 'image:latest';
    if (concern === 'worker-entrypoint') f.service.template.containers[0].args = ['node', 'worker.js'];
    if (concern === 'mixed-traffic') f.service.trafficStatuses[0].percent = 90;
    if (concern === 'revision-path') f.service.latestReadyRevision += '/../../other';
    if (concern === 'always-on') f.revision.scaling.minInstanceCount = 1;
    if (concern === 'service-floor') f.service.scaling = { minInstanceCount: 1 };
    if (concern === 'manual-scale') f.service.scaling = { scalingMode: 'MANUAL', manualInstanceCount: 1 };
    if (concern === 'unbilled-cpu') f.revision.containers[0].resources.cpuIdle = false;
    if (concern === 'wrong-secret') f.revision.volumes[0].secret.items[0].version = 'latest';
    if (concern === 'foreign-source') f.triggers[0].eventFilters[1].value = 'other-database';
    if (concern === 'trigger-error') f.triggers[0].conditions = { transport: { code: 7 } };
    if (concern === 'no-retries') f.triggers[0].retryPolicy = { maxAttempts: 1 };
    if (concern === 'foreign-transport') f.triggers[0].transport.pubsub.topic = 'projects/urm-app/topics/other';
    if (concern === 'paused-scheduler') f.scheduler.state = 'PAUSED';
    if (concern === 'wrong-audience') f.scheduler.httpTarget.oidcToken.audience = 'https://other.invalid';
    if (concern === 'static-auth') f.scheduler.httpTarget.headers = { authorization: 'SYNTHETIC_PRIVATE_VALUE' };
    if (concern === 'public-invoker') f.policy.bindings[0].members = ['allUsers'];
    if (concern === 'conditional-invoker') f.policy.bindings[0].condition = { expression: 'true' };
    if (concern === 'duplicate-env') f.revision.containers[0].env.push(f.revision.containers[0].env[0]);
    const api =
      concern === 'private-api-error'
        ? async () => {
            throw new Error('SYNTHETIC_PRIVATE_VALUE');
          }
        : f.api;
    await assert.rejects(
      verifyCloudRunDispatchConfiguration(f.platform, api),
      (error) => error.message === 'CLOUD_RUN_DISPATCH_CONFIGURATION_UNCONFIRMED'
    );
  });

test('normalizes native numeric project resource names and omitted zero/false scalar fields', async () => {
  const f = fixture();
  const numeric = (value) => value.replace('projects/urm-app-staging/', 'projects/251680231116/');
  f.service.name = numeric(f.service.name);
  f.service.latestReadyRevision = numeric(f.service.latestReadyRevision);
  f.service.latestCreatedRevision = numeric(f.service.latestCreatedRevision);
  f.revision.name = numeric(f.revision.name);
  f.service.reconciling = false;
  f.revision.reconciling = false;
  delete f.service.template.scaling.minInstanceCount;
  delete f.revision.scaling.minInstanceCount;
  for (const trigger of f.triggers) {
    trigger.name = numeric(trigger.name);
    trigger.transport.pubsub.topic = numeric(trigger.transport.pubsub.topic);
    trigger.transport.pubsub.subscription = numeric(trigger.transport.pubsub.subscription);
  }
  f.scheduler.name = numeric(f.scheduler.name);
  const values = [f.service, f.revision, ...f.triggers, f.scheduler, f.policy];
  let index = 0;
  const proof = await verifyCloudRunDispatchConfiguration(f.platform, async () => values[index++]);
  assert.equal(index, 6);
  assert.equal(proof.service.name, f.platform.dispatch.service);
});
