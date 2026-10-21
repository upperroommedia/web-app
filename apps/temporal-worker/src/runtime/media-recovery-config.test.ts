jest.mock('node:fs', () => ({
  readFileSync: (path: string) => (path === '/etc/temporal-worker-build-id' ? 'a'.repeat(40) : 'synthetic-key'),
}));
import { loadRuntimeConfig } from './config';
import { loadMediaRecoveryRuntimeConfig, isMediaRecoveryConfiguration } from './media-recovery-config';
const env = {
  NODE_ENV: 'production',
  FIREBASE_PROJECT_ID: 'urm-app-staging',
  TEMPORAL_NAMESPACE: 'urm-app-staging.qwejt',
  TEMPORAL_CONNECTION_MODE: 'temporal-cloud',
  TEMPORAL_WORKER_HOSTING: 'cloud-run',
  TEMPORAL_CLOUD_ACCOUNT_ID: 'qwejt',
  TEMPORAL_CLOUD_PROVIDER: 'gcp',
  TEMPORAL_CLOUD_REGION: 'us-central1',
  TEMPORAL_ADDRESS: 'us-central1.gcp.api.temporal.io:7233',
  TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-recovery-staging',
  TEMPORAL_BUILD_ID: 'a'.repeat(40),
  TEMPORAL_WORKFLOW_BUNDLE: '/workspace/apps/temporal-worker/lib/media-recovery-workflow-bundle.js',
  TEMPORAL_API_KEY_FILE: '/api-key',
  TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
  TEMPORAL_MEDIA_RECOVERY_OPERATION: '12345678-1234-1234-1234-123456789abc',
  TEMPORAL_MEDIA_CONCURRENCY: '1',
  TEMPORAL_DISPATCHER_ENABLED: 'false',
};
test('private image config preserves fixed queue and credentials without changing input or normal config', () => {
  const before = { ...env };
  const value = loadMediaRecoveryRuntimeConfig(env);
  expect(value.queues).toEqual(['urm-media-kernel-recovery']);
  expect(value.deploymentName).toBe(env.TEMPORAL_DEPLOYMENT_NAME);
  expect(value.operationId).toBe(env.TEMPORAL_MEDIA_RECOVERY_OPERATION);
  expect(value.apiKey).toBe('synthetic-key');
  expect(env).toEqual(before);
  expect(() => loadRuntimeConfig(env)).toThrow('Unknown worker queue');
});
test.each([
  { TEMPORAL_MEDIA_RECOVERY_OPERATION: undefined },
  { TEMPORAL_WORKER_HOSTING: 'traditional' },
  { FIREBASE_PROJECT_ID: 'urm-app' },
  { TEMPORAL_TASK_QUEUES: 'urm-media' },
  { TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery,urm-media' },
  { TEMPORAL_DISPATCHER_ENABLED: 'true' },
  { TEMPORAL_MEDIA_CONCURRENCY: '2' },
  { TEMPORAL_WORKFLOW_BUNDLE: '/bundle-from-caller.js' },
  { TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-staging' },
])('incomplete private config cannot fall back to normal: %j', (patch) => {
  const value = { ...env, ...patch };
  expect(isMediaRecoveryConfiguration(value)).toBe(true);
  expect(() => loadMediaRecoveryRuntimeConfig(value)).toThrow();
});
