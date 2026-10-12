const {test} = require('node:test');
const assert = require('node:assert/strict');
const {migratedRuntimeOptions} = require('../lib/runtime-options');
test('uses conservative defaults when no extension system settings were exported', () => {
  assert.deepEqual(migratedRuntimeOptions({}), {memory: '512MiB', minInstances: 0});
});
test('preserves CLI-exported runtime controls including explicit zero instance minimum', () => {
  assert.deepEqual(migratedRuntimeOptions({FUNCTION_DEFAULT_REGION: 'us-east1', EXT_MIGRATED_SYSTEM_MEMORY: '512MB', EXT_MIGRATED_SYSTEM_MININSTANCES: '0', EXT_MIGRATED_SYSTEM_MAXINSTANCES: '8', EXT_MIGRATED_SYSTEM_TIMEOUT: '120s', EXT_MIGRATED_SYSTEM_VPCCONNECTOR: 'connector', EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS: 'ALL_TRAFFIC', EXT_MIGRATED_SYSTEM_INGRESSSETTINGS: 'ALLOW_INTERNAL_ONLY', EXT_MIGRATED_SYSTEM_CPU: '0.5', EXT_MIGRATED_SYSTEM_LABELS: '{"team":"media"}', EXT_MIGRATED_SYSTEM_SERVICEACCOUNTEMAIL: 'runtime@example.iam.gserviceaccount.com'}), {
    region: 'us-east1', memory: '512MiB', minInstances: 0, maxInstances: 8, timeoutSeconds: 120, vpcConnector: 'connector', vpcConnectorEgressSettings: 'ALL_TRAFFIC', ingressSettings: 'ALLOW_INTERNAL_ONLY', cpu: 0.5, labels: {team: 'media'}, serviceAccount: 'runtime@example.iam.gserviceaccount.com',
  });
});
test('preserves exported memory units, timeoutSeconds, gen1 CPU and concurrency', () => {
  assert.deepEqual(migratedRuntimeOptions({EXT_MIGRATED_SYSTEM_MEMORY: '2GiB', EXT_MIGRATED_SYSTEM_TIMEOUTSECONDS: '300', EXT_MIGRATED_SYSTEM_CPU: 'gcf_gen1', EXT_MIGRATED_SYSTEM_CONCURRENCY: '1'}), {memory: '2GiB', minInstances: 0, timeoutSeconds: 300, cpu: 'gcf_gen1', concurrency: 1});
});
test('ignores API unspecified enum values rather than submitting invalid gen2 settings', () => {
  assert.deepEqual(migratedRuntimeOptions({EXT_MIGRATED_SYSTEM_MEMORY: '256MiB', EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS: 'VPC_CONNECTOR_EGRESS_SETTINGS_UNSPECIFIED', EXT_MIGRATED_SYSTEM_INGRESSSETTINGS: 'INGRESS_SETTINGS_UNSPECIFIED'}), {memory: '256MiB', minInstances: 0});
});
test('rejects malformed migrated settings during discovery', () => {
  for (const env of [{EXT_MIGRATED_SYSTEM_MEMORY: '384MB'}, {EXT_MIGRATED_SYSTEM_MAXINSTANCES: '-1'}, {EXT_MIGRATED_SYSTEM_CPU: 'NaN'}, {EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS: 'invalid'}, {EXT_MIGRATED_SYSTEM_LABELS: '{"bad":1}'}]) assert.throws(() => migratedRuntimeOptions(env));
});
