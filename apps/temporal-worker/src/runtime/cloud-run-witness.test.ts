import { cloudRunPollerIdentity, verifyCloudRunWorkerIdentity } from './cloud-run-witness';

const binding = {
  projectId: 'urm-app-staging',
  region: 'us-central1',
  pool: 'urm-worker-165b5e399d54',
  revision: 'urm-worker-165b5e399d54-00001',
  buildId: '165b5e399d5475f9837951db6cf42582d05b1db0',
  image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'a'.repeat(64)}`,
  serviceAccount: 'temporal-worker@urm-app-staging.iam.gserviceaccount.com',
};
const revision = () => ({
  name: `projects/urm-app-staging/locations/us-central1/workerPools/${binding.pool}/revisions/${binding.revision}`,
  uid: 'revision-uid',
  serviceAccount: binding.serviceAccount,
  containers: [{ name: 'worker', image: binding.image, env: [{ name: 'TEMPORAL_BUILD_ID', value: binding.buildId }] }],
});
const metadata = { projectId: 'urm-app-staging', serviceAccount: binding.serviceAccount, instanceId: 'instance-1' };
test('binds a worker instance to official project, immutable revision, image and service identity', () => {
  expect(verifyCloudRunWorkerIdentity(binding, metadata, revision())).toEqual({
    projectId: binding.projectId,
    region: binding.region,
    pool: binding.pool,
    revision: binding.revision,
    revisionUid: 'revision-uid',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    serviceAccount: binding.serviceAccount,
    instanceId: 'instance-1',
  });
});
test.each(['project', 'serviceAccount', 'image', 'build', 'revision', 'uid'])(
  'fails closed on an unverified %s',
  (mismatch) => {
    const observed = revision();
    const instance = { ...metadata };
    if (mismatch === 'project') instance.projectId = 'urm-app';
    if (mismatch === 'serviceAccount') instance.serviceAccount = 'unexpected@example.com';
    if (mismatch === 'image')
      observed.containers[0].image = observed.containers[0].image.replace('a'.repeat(64), 'b'.repeat(64));
    if (mismatch === 'build') observed.containers[0].env[0].value = 'b'.repeat(40);
    if (mismatch === 'revision') observed.name += '-other';
    if (mismatch === 'uid') observed.uid = '';
    expect(() => verifyCloudRunWorkerIdentity(binding, instance, observed)).toThrow(
      'CLOUD_RUN_WORKER_IDENTITY_MISMATCH'
    );
  }
);

test.each(['CLOUD_RUN_WORKER_POOL', 'CLOUD_RUN_REVISION'])(
  'rejects a configured override of platform identity %s',
  (name) => {
    const observed = revision();
    observed.containers[0].env.push({ name, value: 'forged' });
    expect(() => verifyCloudRunWorkerIdentity(binding, metadata, observed)).toThrow(
      'CLOUD_RUN_WORKER_IDENTITY_MISMATCH'
    );
  }
);

test('poller identities distinguish separate instances and separate process births', () => {
  const processId = '593eeff8-126a-4c05-8233-a394be885c2e';
  const original = cloudRunPollerIdentity('cloud-instance', processId);
  expect(cloudRunPollerIdentity('cloud-instance', processId)).toBe(original);
  expect(cloudRunPollerIdentity('other-instance', processId)).not.toBe(original);
  expect(cloudRunPollerIdentity('cloud-instance', '30f3d81c-664e-4d85-b797-a5fc70dc31d0')).not.toBe(original);
  expect(() => cloudRunPollerIdentity('cloud-instance', '1@localhost')).toThrow('CLOUD_RUN_WORKER_IDENTITY_MISMATCH');
});

test('accepts the documented numbered worker-pool revision only under its exact pool', () => {
  const dotted = { ...binding, revision: `${binding.pool}.1` };
  const observed = { ...revision(), name: revision().name.replace(binding.revision, dotted.revision) };
  expect(verifyCloudRunWorkerIdentity(dotted, metadata, observed).revision).toBe(dotted.revision);
  expect(() =>
    verifyCloudRunWorkerIdentity(dotted, metadata, {
      ...observed,
      name: observed.name.replace(`/workerPools/${binding.pool}/`, '/workerPools/foreign-pool/'),
    })
  ).toThrow('CLOUD_RUN_WORKER_IDENTITY_MISMATCH');
});
