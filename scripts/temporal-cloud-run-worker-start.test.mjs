import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readCloudRunWorkerStart,
  readMediaRecoveryJobOrigins,
  readCloudRunWorkerSystemEvents,
  readMediaBootstrapCloudOrigin,
  readMediaRecoveryCloudOrigin,
} from './temporal-cloud-run-worker-start.mjs';

const to = Date.UTC(2026, 10, 17, 18, 0, 0),
  from = to - 60000;
const at = to - 10000;
const pool = 'urm-worker-controls-aaaaaaaaaaaaaaaaaaaa';
const expected = {
  pool,
  revision: `${pool}.1`,
  revisionUid: 'native-revision-1',
  buildId: 'a'.repeat(40),
  taskQueue: 'urm-controls',
  workerIdentity: `cloud-run-${'b'.repeat(64)}-593eeff8-126a-4c05-8233-a394be885c2e`,
};
const logName = 'projects/urm-app-staging/logs/run.googleapis.com%2Fstdout';
const entry = () => ({
  logName,
  insertId: 'entry-id',
  labels: { instanceId: 'cloud-log-instance-id' },
  resource: {
    type: 'cloud_run_workerpool',
    labels: { project_id: 'urm-app-staging', workerpool_name: pool, location: 'us-central1' },
  },
  timestamp: new Date(at).toISOString(),
  jsonPayload: { event: 'temporal_worker_started', ...expected },
});

test('reads a unique exact runner start through authenticated Cloud Logging scope', async () => {
  const calls = [];
  const api = async (url, method, body) => {
    assert.equal(url, 'https://logging.googleapis.com/v2/entries:list');
    assert.equal(method, 'POST');
    assert.deepEqual(body.resourceNames, ['projects/urm-app-staging']);
    assert.match(body.filter, /resource.type = "cloud_run_workerpool"/);
    assert.ok(body.filter.includes(`jsonPayload.workerIdentity = "${expected.workerIdentity}"`));
    calls.push(body.pageToken);
    return body.pageToken ? { entries: [entry()] } : { nextPageToken: 'next' };
  };
  assert.deepEqual(await readCloudRunWorkerStart({ api, ...expected, from, to }), {
    at,
    instanceId: 'cloud-log-instance-id',
    insertId: 'entry-id',
    workerIdentity: expected.workerIdentity,
  });
  assert.deepEqual(calls, [undefined, 'next']);
});

test('empty, foreign, ambiguous and redacted log results grant no start observation', async () => {
  const read = (reply) => readCloudRunWorkerStart({ api: async () => reply, ...expected, from, to });
  assert.equal(await read({}), null);
  const variants = [
    [{ ...entry(), labels: {} }],
    [{ ...entry(), logName: logName.replace('stdout', 'stderr') }],
    [{ ...entry(), jsonPayload: { ...entry().jsonPayload, revisionUid: 'changed' } }],
    [
      {
        ...entry(),
        resource: { ...entry().resource, labels: { ...entry().resource.labels, revision_name: `${pool}.2` } },
      },
    ],
    [{ ...entry(), timestamp: new Date(from - 1).toISOString() }],
    [entry(), entry()],
  ];
  for (const entries of variants) await assert.rejects(read({ entries }), /UNCONFIRMED/);
  await assert.rejects(read({ nextPageToken: 'repeat' }), /UNCONFIRMED/);
});

test('media bootstrap joins the capacity process to the provider label after log ingestion', async () => {
  const mediaPool = 'urm-worker-media-aaaaaaaaaaaaaaaaaaaa';
  const binding = { role: 'media', poolName: mediaPool, taskQueue: 'urm-media', buildId: expected.buildId };
  const origin = {
    identity: expected.workerIdentity,
    revision: `${mediaPool}.1`,
    revisionUid: expected.revisionUid,
    observedAt: new Date(Date.now() - 1000).toISOString(),
  };
  const logged = entry();
  logged.timestamp = new Date(Date.now() - 500).toISOString();
  logged.resource.labels.workerpool_name = mediaPool;
  logged.jsonPayload = {
    ...logged.jsonPayload,
    pool: mediaPool,
    taskQueue: binding.taskQueue,
    revision: origin.revision,
  };
  let calls = 0;
  const api = async (url, method, body) => {
    assert.equal(url, 'https://logging.googleapis.com/v2/entries:list');
    assert.equal(method, 'POST');
    assert.ok(body.filter.includes(`jsonPayload.workerIdentity = "${origin.identity}"`));
    assert.ok(body.filter.includes(`resource.labels.workerpool_name = "${mediaPool}"`));
    return ++calls === 1 ? {} : { entries: [logged] };
  };
  const result = await readMediaBootstrapCloudOrigin({ api, binding, origin });
  assert.equal(result.instanceId, logged.labels.instanceId);
  assert.equal(result.workerIdentity, origin.identity);
  assert.equal(calls, 2);
  await assert.rejects(
    readMediaBootstrapCloudOrigin({ api, binding, origin: { ...origin, revisionUid: 'replacement' } }),
    /UNCONFIRMED/
  );
  await assert.rejects(
    readMediaBootstrapCloudOrigin({
      api,
      binding,
      origin: { ...origin, observedAt: new Date(Date.now() - 121000).toISOString() },
    }),
    /UNCONFIRMED/
  );
  assert.equal(calls, 3);
});

test('media recovery joins both exact startup records to one provider instance label', async () => {
  const operationId = '923eeff8-126a-4c05-8233-a394be885c2e';
  const name = `projects/urm-app-staging/locations/us-central1/workerPools/${pool}`;
  const plan = {
    operationId,
    name,
    origin: { uid: 'pool-uid' },
    buildId: expected.buildId,
    createdAt: new Date(from).toISOString(),
    expiresAt: to + 60_000,
  };
  const providerPool = {
    uid: plan.origin.uid,
    name,
    revision: `${name}/revisions/${expected.revision}`,
    revisionUid: expected.revisionUid,
  };
  const origin = {
    original: {
      workerIdentity: 'media-recovery-123eeff8-126a-4c05-8233-a394be885c2e',
      metadataInstanceId: 'runtime-metadata',
      startupSHA256: 'e'.repeat(64),
      recordedAt: new Date(from + 5000).toISOString(),
    },
    replacement: {
      workerIdentity: 'media-recovery-223eeff8-126a-4c05-8233-a394be885c2e',
      metadataInstanceId: 'runtime-metadata',
      startupSHA256: 'f'.repeat(64),
      recordedAt: new Date(at).toISOString(),
    },
  };
  let mode;
  const api = async (_url, _method, body) => {
    assert.ok(body.filter.includes(`jsonPayload.operationId = "${operationId}"`));
    const child = body.filter.includes('jsonPayload.child = "original"') ? 'original' : 'replacement';
    if (child === 'replacement' && mode === 'not-yet-visible') return {};
    const startup = origin[child];
    const row = entry();
    return {
      entries: [
        {
          ...row,
          timestamp: startup.recordedAt,
          insertId: child,
          labels: {
            instanceId:
              mode === 'different-instance' && child === 'replacement' ? 'other-provider-label' : 'provider-label',
          },
          jsonPayload: {
            ...row.jsonPayload,
            event: 'temporal_media_recovery_worker_started',
            taskQueue: 'urm-media-kernel-recovery',
            operationId,
            child,
            workerIdentity: startup.workerIdentity,
            startupSHA256: mode === 'mismatched-receipt' ? '1'.repeat(64) : startup.startupSHA256,
          },
        },
      ],
    };
  };
  const read = () => readMediaRecoveryCloudOrigin({ api, plan, pool: providerPool, origin });
  const joined = await read();
  assert.equal(joined.original.instanceId, 'provider-label');
  assert.equal(joined.original.instanceId, joined.replacement.instanceId);
  assert.notEqual(joined.original.workerIdentity, joined.replacement.workerIdentity);
  mode = 'not-yet-visible';
  assert.equal(await read(), null);
  for (mode of ['different-instance', 'mismatched-receipt']) await assert.rejects(read(), /UNCONFIRMED/);
});

test('provider system observation follows exact-instance pages and retains no message text', async () => {
  const logName = 'projects/urm-app-staging/logs/run.googleapis.com%2Fvarlog%2Fsystem';
  const instanceId = 'cloud-log-instance-id';
  const row = { ...entry(), logName, jsonPayload: undefined, textPayload: 'Worker is shutting down' };
  const calls = [];
  const api = async (url, method, body) => {
    assert.equal(url, 'https://logging.googleapis.com/v2/entries:list');
    assert.equal(method, 'POST');
    assert.deepEqual(body.resourceNames, ['projects/urm-app-staging']);
    assert.ok(body.filter.includes(`logName = "${logName}"`));
    assert.ok(body.filter.includes(`labels.instanceId = "${instanceId}"`));
    assert.ok(body.filter.includes(`resource.labels.workerpool_name = "${expected.pool}"`));
    calls.push(body.pageToken);
    return body.pageToken ? { entries: [row] } : { nextPageToken: 'next' };
  };
  const options = { ...expected, from, to, instanceId };
  const [event] = await readCloudRunWorkerSystemEvents({ ...options, api });
  assert.deepEqual(calls, [undefined, 'next']);
  assert.deepEqual(Object.keys(event), ['at', 'insertId', 'lifecycleText', 'payloadSHA256']);
  assert.equal(event.lifecycleText, true);
  assert.match(event.payloadSHA256, /^[a-f0-9]{64}$/);

  const read = (reply) => readCloudRunWorkerSystemEvents({ ...options, api: async () => reply });
  assert.deepEqual(await read({}), []);
  for (const entries of [
    [entry()],
    [{ ...row, labels: { instanceId: 'another-instance' } }],
    [{ ...row, timestamp: new Date(to + 1).toISOString() }],
    [row, row],
  ])
    await assert.rejects(read({ entries }), /UNCONFIRMED/);
  await assert.rejects(read({ nextPageToken: 'repeated' }), /UNCONFIRMED/);
});

test('the registered worker-pool logging descriptor joins only its exact native revision and pool', async () => {
  const row = entry();
  row.resource = {
    type: 'cloud_run_worker_pool',
    labels: {
      project_id: 'urm-app-staging',
      location: 'us-central1',
      worker_pool_name: pool,
      revision_name: expected.revision,
      configuration_name: pool,
    },
  };
  const read = (entries) =>
    readCloudRunWorkerStart({
      ...expected,
      from,
      to,
      api: async (_url, _method, body) => {
        assert.ok(body.filter.includes('resource.type = "cloud_run_worker_pool"'));
        assert.ok(body.filter.includes(`resource.labels.worker_pool_name = "${pool}"`));
        assert.ok(body.filter.includes(`resource.labels.revision_name = "${expected.revision}"`));
        return { entries };
      },
    });
  assert.equal((await read([row])).instanceId, 'cloud-log-instance-id');
  for (const patch of [{ revision_name: undefined }, { revision_name: 'other' }, { worker_pool_name: 'other' }]) {
    await assert.rejects(
      read([{ ...row, resource: { ...row.resource, labels: { ...row.resource.labels, ...patch } } }]),
      /UNCONFIRMED/
    );
  }
  await assert.rejects(read([row, entry()]), /UNCONFIRMED/);
  const system = await readCloudRunWorkerSystemEvents({
    ...expected,
    from,
    to,
    instanceId: row.labels.instanceId,
    api: async () => ({
      entries: [
        {
          ...row,
          logName: 'projects/urm-app-staging/logs/run.googleapis.com%2Fvarlog%2Fsystem',
          textPayload: 'worker shutdown notice',
        },
      ],
    }),
  });
  assert.equal(system.length, 1);
  assert.equal(system[0].lifecycleText, true);
  assert.equal(Object.hasOwn(system[0], 'terminated'), false);
});

test('Job origins share the exact provider task and instance while retaining distinct child identities', async () => {
  const operationId = '1fc647c8-ea06-4fbd-ac05-9d547f5a408f';
  const jobName = 'urm-media-recovery-' + operationId.replaceAll('-', '');
  const job = 'projects/urm-app-staging/locations/us-central1/jobs/' + jobName;
  const execution = jobName + '-staged';
  const at = Date.now() - 10000;
  const date = (plus) => new Date(at + plus).toISOString();
  const plan = { job: { name: job }, operationId, createdAt: date(0), buildId: 'b'.repeat(40) };
  const origin = {
    job: {
      job,
      execution: job + '/executions/' + execution,
      executionUid: 'f862d892-420a-4a11-948a-fddefc5caed0',
      taskUid: '01a1097a-cc47-45fa-88e1-d2d79199948f',
    },
    original: {
      workerIdentity: 'media-recovery-14011233-7db3-470a-aa67-809c72c1d998',
      startupSHA256: 'c'.repeat(64),
      recordedAt: date(1000),
    },
    replacement: {
      workerIdentity: 'media-recovery-2c12f903-bc05-4fb7-9178-be1846c3cfbf',
      startupSHA256: 'd'.repeat(64),
      recordedAt: date(4000),
    },
  };
  const entries = ['original', 'replacement'].map((child, index) => ({
    logName: 'projects/urm-app-staging/logs/run.googleapis.com%2Fstdout',
    resource: {
      type: 'cloud_run_job',
      labels: { project_id: 'urm-app-staging', location: 'us-central1', job_name: jobName },
    },
    labels: { execution_name: execution, task_index: '0', instanceId: 'provider-one' },
    timestamp: date(1010 + index * 3000),
    insertId: 'log-' + child,
    jsonPayload: {
      event: 'temporal_media_recovery_worker_started',
      job,
      executionUid: origin.job.executionUid,
      taskUid: origin.job.taskUid,
      taskQueue: 'urm-media-kernel-recovery',
      buildId: plan.buildId,
      operationId,
      child,
      workerIdentity: origin[child].workerIdentity,
      startupSHA256: origin[child].startupSHA256,
    },
  }));
  const api = async (_url, method, body) => {
    assert.equal(method, 'POST');
    assert.match(body.filter, /resource.type = "cloud_run_job"/);
    assert.match(body.filter, /labels.task_index = "0"/);
    return { entries };
  };
  assert.equal((await readMediaRecoveryJobOrigins({ api, plan, origin })).original.instanceId, 'provider-one');
  entries[1].labels.instanceId = 'foreign-instance';
  await assert.rejects(readMediaRecoveryJobOrigins({ api, plan, origin }), /START_UNCONFIRMED/);
  entries[1].labels.instanceId = 'provider-one';
  entries[1].labels.task_index = '1';
  await assert.rejects(readMediaRecoveryJobOrigins({ api, plan, origin }), /START_UNCONFIRMED/);
});
