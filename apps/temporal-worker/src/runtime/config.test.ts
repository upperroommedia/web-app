let mockImageBuild = 'a'.repeat(40);
let mockApiKey = 'synthetic-test-api-key';
jest.mock('node:fs', () => ({
  readFileSync: (path: string, encoding?: string) => {
    if (path === '/missing-api-key') throw new Error('ENOENT secret contents must never surface');
    if (path === '/api-key') return mockApiKey;
    return path === '/etc/temporal-worker-build-id'
      ? mockImageBuild
      : encoding
      ? 'mounted-test-content'
      : Buffer.from('mounted-test-content');
  },
}));
import { assertRuntimeNamespace, loadRuntimeConfig, runtimeCredentialFingerprint } from './config';
const env = {
  NODE_ENV: 'production',
  FIREBASE_PROJECT_ID: 'stage',
  TEMPORAL_NAMESPACE: 'stage',
  TEMPORAL_ADDRESS: 'private:7233',
  TEMPORAL_DEPLOYMENT_NAME: 'application',
  TEMPORAL_BUILD_ID: 'a'.repeat(40),
  TEMPORAL_WORKFLOW_BUNDLE: '/bundle.js',
  TEMPORAL_TLS_CERT_FILE: '/cert',
  TEMPORAL_TLS_KEY_FILE: '/key',
  TEMPORAL_TLS_CA_FILE: '/ca',
};
test('production cannot mislabel the immutable image as another worker build', () => {
  expect(loadRuntimeConfig(env).buildId).toBe(mockImageBuild);
  expect(() => loadRuntimeConfig({ ...env, TEMPORAL_BUILD_ID: 'b'.repeat(40) })).toThrow('immutable image');
});

const cloudEnv = {
  ...env,
  FIREBASE_PROJECT_ID: 'urm-app-staging',
  TEMPORAL_NAMESPACE: 'urm-app-staging.qwejt',
  TEMPORAL_CONNECTION_MODE: 'temporal-cloud',
  TEMPORAL_CLOUD_ACCOUNT_ID: 'qwejt',
  TEMPORAL_CLOUD_PROVIDER: 'gcp',
  TEMPORAL_CLOUD_REGION: 'us-central1',
  TEMPORAL_ADDRESS: 'us-central1.gcp.api.temporal.io:7233',
  TEMPORAL_API_KEY_FILE: '/api-key',
  TEMPORAL_TLS_CERT_FILE: undefined,
  TEMPORAL_TLS_KEY_FILE: undefined,
  TEMPORAL_TLS_CA_FILE: undefined,
};
beforeEach(() => {
  mockApiKey = 'synthetic-test-api-key';
});
test.each(['urm-app-staging', 'urm-app'])('Cloud pins %s to its reviewed account and GCP region', (projectId) => {
  const config = loadRuntimeConfig({
    ...cloudEnv,
    FIREBASE_PROJECT_ID: projectId,
    TEMPORAL_NAMESPACE: `${projectId}.qwejt`,
  });
  expect(Object.isFrozen(config)).toBe(true);
  expect(config).toMatchObject({
    namespace: `${projectId}.qwejt`,
    connectionMode: 'temporal-cloud',
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
    tls: true,
    apiKey: mockApiKey,
  });
});
test.each([
  { TEMPORAL_NAMESPACE: 'urm-app.qwejt' },
  { FIREBASE_PROJECT_ID: 'unreviewed', TEMPORAL_NAMESPACE: 'unreviewed.qwejt' },
  { TEMPORAL_NAMESPACE: 'urm-app-staging.other', TEMPORAL_CLOUD_ACCOUNT_ID: 'other' },
  { TEMPORAL_CLOUD_ACCOUNT_ID: 'other' },
  { TEMPORAL_CLOUD_PROVIDER: 'aws' },
  { TEMPORAL_CLOUD_REGION: 'us-east4' },
  { TEMPORAL_ADDRESS: 'us-east-1.aws.api.temporal.io:7233' },
  { TEMPORAL_ADDRESS: 'http://us-central1.gcp.api.temporal.io:7233' },
  { TEMPORAL_ADDRESS: 'us-central1.gcp.api.temporal.io.evil:7233' },
  { TEMPORAL_TLS: 'false' },
  { TEMPORAL_TLS_DISABLED: 'true' },
  { TEMPORAL_TLS_CERT_FILE: '/cert' },
  { TEMPORAL_TLS_SERVER_NAME: 'evil' },
  { TEMPORAL_API_KEY: 'raw-env-secret' },
  { TEMPORAL_API_KEY_FILE: undefined },
  { TEMPORAL_API_KEY_FILE: 'relative/key' },
  { TEMPORAL_CONNECTION_MODE: 'unknown' },
])('rejects untrusted Cloud binding, transport or credentials %j before startup', (patch) => {
  expect(() => loadRuntimeConfig({ ...cloudEnv, ...patch })).toThrow();
});
test('unreadable or malformed mounted credentials fail without exposing file contents', () => {
  expect(() => loadRuntimeConfig({ ...cloudEnv, TEMPORAL_API_KEY_FILE: '/missing-api-key' })).toThrow(
    'Cannot read mounted Temporal API key file'
  );
  for (const invalid of ['', 'bad key', 'x'.repeat(16385)]) {
    mockApiKey = invalid;
    expect(() => loadRuntimeConfig(cloudEnv)).toThrow('Invalid mounted Temporal API key');
  }
});
test('local and self-hosted preserve their project binding and production mTLS requirement', () => {
  expect(loadRuntimeConfig(env).tls).toHaveProperty('clientCertPair');
  expect(() => loadRuntimeConfig({ ...env, TEMPORAL_TLS_CERT_FILE: undefined })).toThrow('mutual TLS');
  const local = loadRuntimeConfig({
    ...env,
    NODE_ENV: 'development',
    TEMPORAL_TLS_CERT_FILE: undefined,
    TEMPORAL_TLS_KEY_FILE: undefined,
    TEMPORAL_TLS_CA_FILE: undefined,
  });
  expect(local).toMatchObject({ connectionMode: 'self-hosted', namespace: 'stage' });
  expect(local.tls).toBeUndefined();
  expect(() => loadRuntimeConfig({ ...env, TEMPORAL_API_KEY_FILE: '/api-key' })).toThrow(
    'explicit Temporal Cloud mode'
  );
});
test('rotation fingerprint changes for a reloaded mounted key, without returning credentials', () => {
  const initial = runtimeCredentialFingerprint(loadRuntimeConfig(cloudEnv));
  expect(runtimeCredentialFingerprint(loadRuntimeConfig(cloudEnv))).toBe(initial);
  expect(initial).toMatch(/^[a-f0-9]{64}$/);
  mockApiKey = 'synthetic-rotated-api-key';
  expect(runtimeCredentialFingerprint(loadRuntimeConfig(cloudEnv))).not.toBe(initial);
  expect(runtimeCredentialFingerprint({})).toBeUndefined();
});
test('authenticated namespace verification rejects mismatches and missing server namespace metadata', () => {
  const config = loadRuntimeConfig(cloudEnv);
  expect(() => assertRuntimeNamespace(config, 'urm-app-staging.qwejt')).not.toThrow();
  expect(() => assertRuntimeNamespace(config, 'urm-app.qwejt')).toThrow('different namespace');
  expect(() => assertRuntimeNamespace(config, undefined)).toThrow('different namespace');
});

test('mTLS rotation comparison includes the server identity and each independently framed credential', () => {
  const tls = {
    serverRootCACertificate: Buffer.from('ab'),
    clientCertPair: { crt: Buffer.from('c'), key: Buffer.from('d') },
  };
  const initial = runtimeCredentialFingerprint({ tls });
  expect(runtimeCredentialFingerprint({ tls: { ...tls, serverNameOverride: 'new-private-server' } })).not.toBe(initial);
  expect(
    runtimeCredentialFingerprint({
      tls: {
        serverRootCACertificate: Buffer.from('a'),
        clientCertPair: { crt: Buffer.from('bc'), key: Buffer.from('d') },
      },
    })
  ).not.toBe(initial);
});

test.each(['urm-app-staging', 'urm-app'])(
  'Cloud accepts only the exact %s namespace DNS endpoint for automatic failover',
  (projectId) => {
    const namespace = `${projectId}.qwejt`;
    const config = loadRuntimeConfig({
      ...cloudEnv,
      FIREBASE_PROJECT_ID: projectId,
      TEMPORAL_NAMESPACE: namespace,
      TEMPORAL_ADDRESS: `${namespace}.tmprl.cloud:7233`,
    });
    expect(config.address).toBe(`${namespace}.tmprl.cloud:7233`);
    expect(config.cloudRegion).toBe('us-central1');
    expect(config.tls).toBe(true);
  }
);
test.each([
  'urm-app.qwejt.tmprl.cloud:7233',
  'urm-app-staging.other.tmprl.cloud:7233',
  'other.qwejt.tmprl.cloud:7233',
  'urm-app-staging.qwejt.tmprl.cloud.evil:7233',
  'http://urm-app-staging.qwejt.tmprl.cloud:7233',
  'urm-app-staging.qwejt.tmprl.cloud:443',
  'us-east4.gcp.api.temporal.io:7233',
  'aws-us-east-1.region.tmprl.cloud:7233',
])('Cloud rejects unbound or incorrectly formed namespace endpoint %s', (address) => {
  expect(() => loadRuntimeConfig({ ...cloudEnv, TEMPORAL_ADDRESS: address })).toThrow('trusted namespace');
});
