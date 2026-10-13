import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTORE_SCHEMAS,
  restoreNetworkPolicy,
  validateSystemIdentity,
  schemaProofSql,
  validateSchemaProof,
  validateRestoreIdentity,
  validateRecoveryLog,
} from './temporal-backup.mjs';
const config = { backupDestination: 's3://backups/staging', backupEndpoint: 'https://backup.example.com' };
const source = {
  metadata: { uid: 'source-uid', creationTimestamp: '2026-01-01T00:00:00Z' },
  status: { systemID: '12345' },
};
const restored = {
  spec: {
    bootstrap: { recovery: { source: 'source', recoveryTarget: { targetTime: '2026-02-02T10:00:00Z' } } },
    externalClusters: [
      {
        name: 'source',
        plugin: {
          name: 'barman-cloud.cloudnative-pg.io',
          parameters: { barmanObjectName: 'temporal-backups', serverName: 'temporal-postgres' },
        },
      },
    ],
  },
};
const objectStore = {
  metadata: { name: 'temporal-backups' },
  spec: {
    configuration: {
      destinationPath: config.backupDestination,
      endpointURL: config.backupEndpoint,
      s3Credentials: {
        accessKeyId: { name: 'temporal-restore-objectstore' },
        secretAccessKey: { name: 'temporal-restore-objectstore' },
      },
    },
  },
};
const backup = {
  metadata: { name: 'backup-one', creationTimestamp: '2026-02-01T00:00:00Z' },
  spec: {
    cluster: { name: 'temporal-postgres' },
    method: 'plugin',
    pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
  },
  status: { phase: 'completed', stoppedAt: '2026-02-01T01:00:00Z' },
};
const identity = () =>
  validateRestoreIdentity(config, restored, objectStore, source, [backup], Date.parse('2026-03-01T00:00:00Z'));
const postgresLogs = (...messages) =>
  messages.map((message) => JSON.stringify({ logger: 'postgres', record: { message } })).join('\n');
const start = 'starting point-in-time recovery to 2026-02-02 10:00:00+00';
const stop = 'recovery stopping before commit of transaction 22, time 2026-02-02 10:00:01+00';
const proof = (database) => ({
  database,
  tables: RESTORE_SCHEMAS[database].tables,
  markers: [
    {
      database,
      partition: 0,
      version: RESTORE_SCHEMAS[database].version,
      minimumVersion: '1.0',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
});

test('both pinned schemas require application tables and real bootstrap markers', () => {
  for (const database of Object.keys(RESTORE_SCHEMAS)) {
    assert.equal(validateSchemaProof(database, proof(database)).version, RESTORE_SCHEMAS[database].version);
    assert.match(schemaProofSql(database), /public.schema_version/);
    assert.match(schemaProofSql(database), /pg_control_system/);
  }
});
test('empty databases and unrelated PostgreSQL tables cannot prove restored Temporal data', () => {
  for (const database of Object.keys(RESTORE_SCHEMAS)) {
    assert.throws(
      () => validateSchemaProof(database, { database, tables: ['pg_class'], markers: [] }),
      /missing expected/
    );
    const p = proof(database);
    p.tables = p.tables.filter(
      (table) => table !== (database === 'temporal' ? 'history_node' : 'executions_visibility')
    );
    assert.throws(() => validateSchemaProof(database, p), /missing expected/);
  }
});
test('missing, duplicate, wrong database, uninitialized and incompatible schema versions fail', () => {
  for (const transform of [
    (p) => {
      p.markers = null;
    },
    (p) => p.markers.push(p.markers[0]),
    (p) => {
      p.markers[0].database = 'unrelated';
    },
    (p) => {
      p.markers[0].version = '0.0';
    },
    (p) => {
      p.markers[0].minimumVersion = '9.0';
    },
    (p) => {
      p.markers[0].createdAt = null;
    },
  ]) {
    const p = structuredClone(proof('temporal'));
    transform(p);
    assert.throws(() => validateSchemaProof('temporal', p), /marker|minimum/);
  }
});
test('restore binds the original archive and completed backup before its target', () => {
  const p = identity();
  assert.equal(p.sourceSystemId, '12345');
  assert.equal(p.sourceBackup, 'backup-one');
});
test('unrelated archives, write credentials, server identity and writable restore fail', () => {
  for (const change of [
    (o) => {
      o.spec.configuration.destinationPath = 's3://other/production';
    },
    (o) => {
      o.spec.configuration.endpointURL = 'https://other.example.com';
    },
    (o) => {
      o.spec.configuration.s3Credentials.accessKeyId.name = 'temporal-backup-objectstore';
    },
  ]) {
    const o = structuredClone(objectStore);
    change(o);
    assert.throws(() => validateRestoreIdentity(config, restored, o, source, [backup]), /archive/);
  }
  const r = structuredClone(restored);
  r.spec.externalClusters[0].plugin.parameters.serverName = 'unrelated';
  assert.throws(() => validateRestoreIdentity(config, r, objectStore, source, [backup]), /identity/);
  const writable = structuredClone(restored);
  writable.spec.plugins = [{ name: 'archiver' }];
  assert.throws(() => validateRestoreIdentity(config, writable, objectStore, source, [backup]), /identity/);
});
test('post-target, failed and stale former-cluster backups cannot prove restore viability', () => {
  for (const change of [
    (b) => {
      b.status.stoppedAt = '2026-02-03T00:00:00Z';
    },
    (b) => {
      b.status.phase = 'failed';
    },
    (b) => {
      b.metadata.creationTimestamp = '2025-12-01T00:00:00Z';
    },
    (b) => {
      b.spec.cluster.name = 'other';
    },
  ]) {
    const b = structuredClone(backup);
    change(b);
    assert.throws(() => validateRestoreIdentity(config, restored, objectStore, source, [b]), /No completed/);
  }
});
test('missing, future and ambiguous targets cannot pass', () => {
  for (const target of [
    {},
    { targetTime: '2040-01-01T00:00:00Z' },
    { targetTime: '2026-02-02T10:00:00Z', targetLSN: '0/100' },
  ]) {
    const r = structuredClone(restored);
    r.spec.bootstrap.recovery.recoveryTarget = target;
    assert.throws(() => validateRestoreIdentity(config, r, objectStore, source, [backup]), /target/);
  }
});
test('actual PostgreSQL recovery logs prove configured target and crossed transaction boundary', () => {
  assert.equal(validateRecoveryLog(postgresLogs(start, stop), identity()).targetReached, true);
});
test('ready database, missing logs, wrong target and early WAL exhaustion cannot prove PITR', () => {
  for (const log of [
    postgresLogs('database system is ready to accept connections'),
    postgresLogs(start),
    postgresLogs(start.replace('10:00:00', '09:00:00'), stop),
    postgresLogs(start, stop.replace('10:00:01', '09:59:59')),
    postgresLogs(start, stop, 'recovery ended before configured recovery target was reached'),
  ]) {
    assert.throws(() => validateRecoveryLog(log, identity()), /recovery|Recovery/);
  }
});
test('inclusive target requires excluding a later transaction, exclusive allows equal boundary', () => {
  const log = postgresLogs(start, stop.replace('10:00:01', '10:00:00'));
  assert.throws(() => validateRecoveryLog(log, identity()), /boundary/);
  assert.equal(validateRecoveryLog(log, { ...identity(), exclusive: true }).targetReached, true);
});

test('restored system identifier must match the original source, not a same-named empty replacement', () => {
  validateSystemIdentity({ systemId: '12345' }, '12345');
  for (const proof of [{}, { systemId: '67890' }, { systemId: 12345 }])
    assert.throws(() => validateSystemIdentity(proof, '12345'), /identifier/);
  assert.throws(() => validateSystemIdentity({ systemId: '12345' }, undefined), /identifier/);
});

test('isolated restore retains explicit private API connectivity without admitting application pods', () => {
  const endpoints = [
    { cidr: '10.43.0.1/32', port: 443 },
    { cidr: '10.0.0.1/32', port: 6443 },
  ];
  const policy = restoreNetworkPolicy(
    { kubernetesApiEndpoints: endpoints, applicationEgressCidrs: ['203.0.113.1/32'] },
    'temporal-restore-test'
  );
  assert.equal(policy.spec.podSelector.matchLabels['urm.temporal/database-network'], 'temporal-postgres-restore');
  for (const { cidr, port } of endpoints)
    assert.ok(
      policy.spec.egress.some(
        (rule) => rule.to?.some((peer) => peer.ipBlock?.cidr === cidr) && rule.ports.some((p) => p.port === port)
      )
    );
  assert.ok(
    !policy.spec.ingress.some((rule) =>
      rule.from.some((peer) => peer.podSelector?.matchLabels?.['app.kubernetes.io/name'])
    )
  );
});
