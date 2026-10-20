import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchResourceNames,
  renderServerlessDispatchService,
  renderServerlessDispatchWakeups,
} from './temporal-serverless-dispatch-resources.mjs';
const config = () => ({
  projectId: 'urm-app-staging',
  region: 'us-central1',
  buildId: 'e'.repeat(40),
  image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'f'.repeat(64)}`,
  apiKeyVersion: '2',
});
const observed = () => {
  const names = dispatchResourceNames(config().buildId);
  return { name: names.service, uri: `https://${names.serviceId}-251680231116.us-central1.run.app` };
};
test('private dispatch uses request-billed zero-minimum compute and a separate image entrypoint', () => {
  const c = config();
  const s = renderServerlessDispatchService(c, 'enabled', { audience: observed().uri, eventSubject: '12345678901234567891', schedulerSubject: '12345678901234567892' });
  const n = dispatchResourceNames(c.buildId);
  assert.equal(s.name, n.service);
  assert.equal(s.invokerIamDisabled, false);
  assert.deepEqual(s.scaling, { minInstanceCount: 0, maxInstanceCount: 1 });
  assert.deepEqual(s.template.scaling, { minInstanceCount: 0, maxInstanceCount: 1 });
  assert.equal(s.template.maxInstanceRequestConcurrency, 1);
  assert.equal(s.template.timeout, '30s');
  assert.equal(s.template.serviceAccount, n.runnerServiceAccount);
  const container = s.template.containers[0];
  assert.equal(container.image, c.image);
  assert.deepEqual(container.args, ['node', 'apps/temporal-worker/lib/apps/temporal-worker/src/dispatch.js']);
  assert.equal(container.resources.cpuIdle, true);
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
  assert.equal(env.TEMPORAL_DISPATCHER_ENABLED, 'false');
  assert.equal(env.TEMPORAL_DISPATCH_RECONCILE_JOB, n.reconcileJob);
  assert.equal(env.FIREBASE_PROJECT_ID, c.projectId);
  assert.equal(env.TEMPORAL_BUILD_ID, c.buildId);
  assert.equal(Object.hasOwn(env, 'GOOGLE_APPLICATION_CREDENTIALS'), false);
  for (const name of ['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION'])
    assert.equal(Object.hasOwn(env, name), false);
  assert.equal(s.template.volumes[0].secret.secret, 'TEMPORAL_WORKER_API_KEY');
  assert.equal(s.template.volumes[0].secret.items[0].version, '2');
});
test('two collection-scoped Firestore triggers preserve delivery retries and discard payloads at the handler', () => {
  const r = renderServerlessDispatchWakeups(config(), observed());
  assert.equal(r.triggers.length, 2);
  for (const [index, collection] of ['durableJobOutbox', 'durableJobCommands'].entries()) {
    const trigger = r.triggers[index];
    assert.deepEqual(trigger.eventFilters, [
      { attribute: 'type', value: 'google.cloud.firestore.document.v1.written' },
      { attribute: 'database', value: '(default)' },
      { attribute: 'document', value: `${collection}/*`, operator: 'match-path-pattern' },
    ]);
    assert.equal(trigger.eventDataContentType, 'application/protobuf');
    assert.equal(trigger.destination.cloudRun.path, '/dispatch');
    assert.equal(trigger.retryPolicy, undefined);
  }
});
test('independent Scheduler wake uses OIDC to the observed service origin and preserves retry reconciliation', () => {
  const c = config();
  const n = dispatchResourceNames(c.buildId);
  const r = renderServerlessDispatchWakeups(c, observed());
  assert.equal(r.scheduler.name, n.reconcileJob);
  assert.equal(r.scheduler.schedule, '* * * * *');
  assert.equal(r.scheduler.httpTarget.uri, `${observed().uri}/reconcile`);
  assert.deepEqual(r.scheduler.httpTarget.oidcToken, {
    serviceAccountEmail: n.schedulerServiceAccount,
    audience: observed().uri,
  });
  assert.equal(r.scheduler.httpTarget.httpMethod, 'POST');
  assert.equal(r.scheduler.attemptDeadline, '30s');
  assert.ok(r.scheduler.retryConfig.retryCount > 0);
  assert.equal(r.serviceInvokerGrant.resource, n.service);
  assert.equal(r.serviceInvokerGrant.role, 'roles/run.invoker');
  assert.deepEqual(
    r.serviceInvokerGrant.members.sort(),
    [n.eventServiceAccount, n.schedulerServiceAccount].map((e) => `serviceAccount:${e}`).sort()
  );
  assert.equal(new Set([n.runnerServiceAccount, n.eventServiceAccount, n.schedulerServiceAccount]).size, 3);
});
for (const patch of [
  { projectId: 'urm-app' },
  { region: 'us-east1' },
  { buildId: 'latest' },
  { apiKeyVersion: 'latest' },
  { image: 'worker:latest' },
  { minInstances: 1 },
  { runtimeSecrets: [{ name: 'SUBSPLASH_PASSWORD' }] },
])
  test('rejects unreviewed resource configuration', () =>
    assert.throws(() => renderServerlessDispatchService({ ...config(), ...patch }, 'enabled')));
test('wakeups cannot target another service or arbitrary credential-bearing URL', () => {
  for (const patch of [
    { name: observed().name.replace('urm-app-staging', 'urm-app') },
    { uri: 'https://other.run.app' },
    { uri: `${observed().uri}/path` },
    { uri: `${observed().uri}?token=private` },
    { uri: `https://user:pass@${new URL(observed().uri).host}` },
    { uri: observed().uri.replace('https:', 'http:') },
  ])
    assert.throws(() => renderServerlessDispatchWakeups(config(), { ...observed(), ...patch }));
});
test('enabled caller environment requires the native URI and distinct original numeric subjects',()=>{
 const c=config(),identity={audience:observed().uri,eventSubject:'12345678901234567891',schedulerSubject:'12345678901234567892'};
 const env=renderServerlessDispatchService(c,'enabled',identity).template.containers[0].env;
 assert.equal(env.find(e=>e.name==='TEMPORAL_DISPATCH_AUDIENCE').value,identity.audience);
 assert.equal(env.find(e=>e.name==='TEMPORAL_DISPATCH_EVENT_SUBJECT').value,identity.eventSubject);
 for(const bad of [undefined,{...identity,audience:identity.audience+'/foreign'},{...identity,eventSubject:'not-a-subject'},
  {...identity,eventSubject:identity.schedulerSubject},{...identity,unexpected:true}])
  assert.throws(()=>renderServerlessDispatchService(c,'enabled',bad));
 assert.throws(()=>renderServerlessDispatchService(c,'disabled',identity));
});
