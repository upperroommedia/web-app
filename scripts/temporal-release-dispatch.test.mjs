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
  const service = renderServerlessDispatchService(config, 'enabled', { audience: `https://${platform.dispatch.serviceId}-251680231116.us-central1.run.app`, eventSubject: '12345678901234567891', schedulerSubject: '12345678901234567892' });
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
  const managedPolicy = { version: 3, etag: 'native-project', auditConfigs: [{service:'eventarc.googleapis.com',auditLogConfigs:[{logType:'DATA_WRITE'}]}], bindings: ['eventarc','cloudscheduler','pubsub'].map(s => ({ role: `roles/${s}.serviceAgent`, members: [`serviceAccount:service-251680231116@gcp-sa-${s}.iam.gserviceaccount.com`] })) };
  managedPolicy.bindings.push({role:'roles/eventarc.eventReceiver',members:[`serviceAccount:${platform.dispatch.eventServiceAccount}`]});
  const calls = [];
  const api = async (url, method = 'GET', body) => {
    calls.push({ url, method, body });
    if (url.startsWith('https://cloudresourcemanager.')) { assert.equal(method,'POST'); assert.deepEqual(body,{options:{requestedPolicyVersion:3}}); return managedPolicy; }
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    for (const [email, uniqueId] of [[platform.dispatch.eventServiceAccount, '12345678901234567891'], [platform.dispatch.schedulerServiceAccount, '12345678901234567892']])
      if (url === `https://iam.googleapis.com/v1/projects/urm-app-staging/serviceAccounts/${email}`) return { email, uniqueId, projectId: 'urm-app-staging' };
    if (url.includes(':getIamPolicy')) return policy;
    if (url.endsWith(revision.name)) return revision;
    if (url.endsWith(service.name)) return service;
    for (const trigger of triggers) if (url.endsWith(trigger.name)) return trigger;
    if (url.endsWith(scheduler.name)) return scheduler;
    throw new Error('Unexpected native endpoint');
  };
  return { platform, service, revision, triggers, scheduler, policy, managedPolicy, api, calls };
}
test('joins private dispatch serving revision, zero-minimum settings, native wake configuration and direct IAM', async () => {
  const f = fixture();
  const proof = await verifyCloudRunDispatchConfiguration(f.platform, f.api);
  assert.equal(proof.buildId, buildId);
  assert.equal(proof.triggers.length, 2);
  assert.equal(proof.service.revisionUid, 'revision-uid');
  assert.equal(f.calls.length, 9);
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
  const values = [f.service,
    { email: f.platform.dispatch.eventServiceAccount, projectId: 'urm-app-staging', uniqueId: '12345678901234567891' },
    { email: f.platform.dispatch.schedulerServiceAccount, projectId: 'urm-app-staging', uniqueId: '12345678901234567892' }, f.revision, ...f.triggers, f.scheduler, f.policy, f.managedPolicy];
  let index = 0;
  const proof = await verifyCloudRunDispatchConfiguration(f.platform, async () => values[index++]);
  assert.equal(index, 9);
  assert.equal(proof.service.name, f.platform.dispatch.service);
});

test('final dispatch configuration requires event-receiver role and managed agents, not only invocation grants',async()=>{
 for(const index of [0,1,2,3]){const f=fixture();f.managedPolicy.bindings.splice(index,1);
 await assert.rejects(verifyCloudRunDispatchConfiguration(f.platform,f.api));}
});
test('final enabled dispatch cannot replace missing audit policy or override applicable exemptions',async()=>{
 for(const bad of ['missing','exemption']){const f=fixture();
 if(bad==='missing')f.managedPolicy.auditConfigs=[];
 else f.managedPolicy.auditConfigs.push({service:'allServices',auditLogConfigs:[{logType:'DATA_WRITE',exemptedMembers:['user:other@example.test']}]});
 await assert.rejects(verifyCloudRunDispatchConfiguration(f.platform,f.api));}
});
test('enabled native readback rejects recreated or disabled callers and audience drift',async()=>{
 for(const bad of ['recreated','disabled','audience']){
  const f=fixture(),api=f.api;
  if(bad==='audience')f.service.uri=f.service.uri.replace('251680231116','251680231117');
  await assert.rejects(verifyCloudRunDispatchConfiguration(f.platform,async(...args)=>{
   const value=await api(...args);
   if(args[0].startsWith('https://iam.')&&args[0].endsWith(f.platform.dispatch.eventServiceAccount)){
    if(bad==='recreated')return {...value,uniqueId:'99999999999999999999'};
    if(bad==='disabled')return {...value,disabled:true};
   }
   return value;
  }));
 }
});

test('Scheduler attempts can advance while the exact enabled job configuration stays pinned', async () => {
  const f = fixture();
  Object.assign(f.scheduler, {
    userUpdateTime: '2026-11-17T00:00:00Z',
    lastAttemptTime: '2026-11-17T00:01:00Z',
    scheduleTime: '2026-11-17T00:02:00Z',
    status: { code: 0 },
  });
  const first = await verifyCloudRunDispatchConfiguration(f.platform, f.api);
  Object.assign(f.scheduler, {
    lastAttemptTime: '2026-11-17T00:02:00Z',
    scheduleTime: '2026-11-17T00:03:00Z',
    status: { code: 14 },
  });
  const second = await verifyCloudRunDispatchConfiguration(f.platform, f.api);
  const withoutObservationTime = ({ observedAt, ...configuration }) => configuration;
  assert.deepEqual(withoutObservationTime(first), withoutObservationTime(second));
  assert.equal(second.scheduler.configurationDigestVersion, 2);
  f.scheduler.description = 'A different ownership annotation';
  const changed = await verifyCloudRunDispatchConfiguration(f.platform, f.api);
  assert.notEqual(changed.scheduler.configurationSHA256, second.scheduler.configurationSHA256);
});
