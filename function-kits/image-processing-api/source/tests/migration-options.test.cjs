const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migratedGlobalOptions } = require('../lib/migration-options.js');
test('preserves exported advanced system values and zero minimum instances', () => {
  assert.deepEqual(migratedGlobalOptions({ EXT_MIGRATED_SYSTEM_MEMORY: '2GiB', EXT_MIGRATED_SYSTEM_TIMEOUTSECONDS: '120', EXT_MIGRATED_SYSTEM_MAXINSTANCES: '3', EXT_MIGRATED_SYSTEM_MININSTANCES: '0', EXT_MIGRATED_SYSTEM_VPCCONNECTOR: 'connector', EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS: 'ALL_TRAFFIC', EXT_MIGRATED_SYSTEM_INGRESSSETTINGS: 'ALLOW_ALL', EXT_MIGRATED_SYSTEM_LABELS: ' hello:world, empty:,missing,b: two' }), { memory: '2GiB', concurrency: 4, maxInstances: 3, minInstances: 0, timeoutSeconds: 120, vpcConnector: 'connector', vpcConnectorEgressSettings: 'ALL_TRAFFIC', ingressSettings: 'ALLOW_ALL', labels: { hello: 'world', b: 'two' } });
});
test('omits unsupported protobuf sentinel values present in the live export', () => {
  const options = migratedGlobalOptions({ EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS: 'VPC_CONNECTOR_EGRESS_SETTINGS_UNSPECIFIED', EXT_MIGRATED_SYSTEM_INGRESSSETTINGS: 'INGRESS_SETTINGS_UNSPECIFIED' });
  assert.equal(options.vpcConnectorEgressSettings, undefined); assert.equal(options.ingressSettings, undefined);
});
test('rejects invalid advanced configuration before deployment', () => {
  assert.throws(() => migratedGlobalOptions({ EXT_MIGRATED_SYSTEM_MEMORY: 'nonsense' }), /invalid/);
  assert.throws(() => migratedGlobalOptions({ EXT_MIGRATED_SYSTEM_MAXINSTANCES: 'NaN' }), /non-negative/);
});
