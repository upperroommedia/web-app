import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import {
  readServerlessResource,
  validateServerlessRoleBinding,
  verifyServerlessPool,
  type ServerlessRoleBinding,
} from './serverless-release-readiness';
import { workerReadinessDigest } from './readiness-probe';
const name = 'projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-controls-aaaaaaaaaaaaaaaaaaaa';
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('native resource read bounds stalled auth and prevents late auth from issuing HTTP', async () => {
  jest.useFakeTimers();
  const client = new OAuth2Client();
  const request = jest.spyOn(client, 'request');
  let release!: (value: OAuth2Client) => void;
  const pending = new Promise<OAuth2Client>((resolve) => {
    release = resolve;
  });
  jest.spyOn(GoogleAuth.prototype, 'getClient').mockImplementation(() => pending);
  const result = readServerlessResource(name);
  const failure = expect(result).rejects.toThrow('SERVERLESS_NATIVE_RESOURCE_READ_UNCONFIRMED');
  await jest.advanceTimersByTimeAsync(15000);
  await failure;
  release(client);
  await Promise.resolve();
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});
test('native resource read also bounds a stalled authenticated request', async () => {
  jest.useFakeTimers();
  const client = new OAuth2Client();
  jest.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(client);
  jest.spyOn(client, 'request').mockImplementation(() => new Promise(() => {}));
  const result = readServerlessResource(name);
  const failure = expect(result).rejects.toThrow('SERVERLESS_NATIVE_RESOURCE_READ_UNCONFIRMED');
  await jest.advanceTimersByTimeAsync(15000);
  await failure;
});
test('receipt digest survives reordered Firestore maps but rejects changed identity', () => {
  const one = { worker: { instanceId: 'native-1', buildId: 'a'.repeat(40) }, role: 'controls' };
  const reordered = { role: 'controls', worker: { buildId: 'a'.repeat(40), instanceId: 'native-1' } };
  expect(workerReadinessDigest(one)).toBe(workerReadinessDigest(reordered));
  expect(workerReadinessDigest(one)).not.toBe(
    workerReadinessDigest({ ...reordered, worker: { ...reordered.worker, instanceId: 'foreign' } })
  );
});

function fixture() {
  const binding: ServerlessRoleBinding = {
    projectId: 'urm-app-staging',
    namespace: 'urm-app-staging.qwejt',
    region: 'us-central1',
    role: 'controls',
    buildId: 'a'.repeat(40),
    poolName: `urm-worker-controls-${'a'.repeat(20)}`,
    deploymentName: 'urm-worker-controls-staging',
    runnerServiceAccount: `tw-c-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
    image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
  };
  const parent = `projects/urm-app-staging/locations/us-central1/workerPools/${binding.poolName}`;
  const name = `${parent}/revisions/${binding.poolName}-00001`;
  const pool = {
    name: parent,
    uid: 'pool-1',
    generation: '9007199254740993',
    observedGeneration: '9007199254740993',
    reconciling: false,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: name,
    latestCreatedRevision: name,
    instanceSplits: [],
    instanceSplitStatuses: [{ type: 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST', revision: name, percent: 100 }],
  };
  const revision = {
    name,
    uid: 'revision-1',
    generation: '1',
    observedGeneration: '1',
    reconciling: false,
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    serviceAccount: binding.runnerServiceAccount,
    containers: [
      {
        name: 'worker',
        image: binding.image,
        env: Object.entries({
          TEMPORAL_BUILD_ID: binding.buildId,
          TEMPORAL_TASK_QUEUES: 'urm-controls',
          TEMPORAL_DEPLOYMENT_NAME: binding.deploymentName,
          TEMPORAL_WORKER_HOSTING: 'cloud-run',
          TEMPORAL_DISPATCHER_ENABLED: 'false',
        }).map(([name, value]) => ({ name, value })),
      },
    ],
  };
  return { binding, pool, revision };
}
test('official latest default and int64 generations preserve declared identity without claiming resolved bytes', () => {
  const f = fixture(),
    result = verifyServerlessPool(f.binding, f.pool, f.revision);
  expect(result.poolGeneration).toBe('9007199254740993');
  expect(result.declaredImage).toBe(f.binding.image);
  expect(result).not.toHaveProperty('imageDigest');
});
test.each(['generation', 'reconciling', 'created', 'split', 'condition', 'uid', 'queue', 'duplicate-env'])(
  'rejects a stale or mismatched native %s observation',
  (mismatch) => {
    const f = fixture();
    if (mismatch === 'generation') f.pool.observedGeneration = '9007199254740992';
    if (mismatch === 'reconciling') f.pool.reconciling = true;
    if (mismatch === 'created') f.pool.latestCreatedRevision += '-old';
    if (mismatch === 'split') f.pool.instanceSplitStatuses[0].revision += '-old';
    if (mismatch === 'condition') f.revision.conditions[0].state = 'CONDITION_PENDING';
    if (mismatch === 'uid') f.revision.uid = '';
    if (mismatch === 'queue')
      f.revision.containers[0].env.find((v) => v.name === 'TEMPORAL_TASK_QUEUES')!.value = 'urm-media';
    if (mismatch === 'duplicate-env')
      f.revision.containers[0].env.push({ name: 'TEMPORAL_BUILD_ID', value: f.binding.buildId });
    expect(() => verifyServerlessPool(f.binding, f.pool, f.revision)).toThrow();
  }
);

test('unexpected private binding fields cannot enter the saved intent', () => {
  const f = fixture();
  const accidental = { ...f.binding, privateCredential: 'SYNTHETIC_ONLY' };
  expect(() => validateServerlessRoleBinding(accidental)).toThrow();
});

test('omitted protobuf false reconciliation fields retain all positive readiness checks', () => {
  const { binding, pool, revision } = fixture();
  Reflect.deleteProperty(pool, 'reconciling');
  Reflect.deleteProperty(revision, 'reconciling');
  expect(verifyServerlessPool(binding, pool, revision).poolUid).toBe('pool-1');
  for (const invalid of [true, null, 'false', 0]) {
    expect(() => verifyServerlessPool(binding, { ...pool, reconciling: invalid }, revision)).toThrow();
    expect(() => verifyServerlessPool(binding, pool, { ...revision, reconciling: invalid })).toThrow();
  }
  expect(() => verifyServerlessPool(binding, { ...pool, observedGeneration: '1' }, revision)).toThrow();
  expect(() =>
    verifyServerlessPool(binding, { ...pool, terminalCondition: { state: 'CONDITION_FAILED' } }, revision)
  ).toThrow();
});
