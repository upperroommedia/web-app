import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWitnessSource,
  validateWitness,
  validateWitnessRows,
  witnessQuery,
  markerSql,
} from './temporal-restore-witness.mjs';
const c = { environment: 'staging', clusterUid: 'kube-uid', postgresHost: 'postgres.private' };
const source = { metadata: { uid: 'pg-uid' }, status: { systemID: '12345' } };
const witness = {
  schemaVersion: 1,
  result: 'prepared',
  ...c,
  sourceClusterUid: 'pg-uid',
  sourceSystemId: '12345',
  sourceBackup: 'witness-backup',
  backupCompletedAt: '2026-01-01T10:00:00Z',
  targetTime: '2026-01-01T10:01:00Z',
  beforeId: '11111111-1111-4111-8111-111111111111',
  afterId: '22222222-2222-4222-8222-222222222222',
  archivedWalSegment: '000000010000000000000022',
  databases: ['temporal', 'temporal_visibility'].map((database) => ({
    database,
    beforeTime: '2026-01-01T09:59:00Z',
    afterTime: '2026-01-01T10:02:00Z',
  })),
};
test('explicit prepared witness proves two databases bracket exact target', () =>
  assert.equal(validateWitness(witness, c, source), witness));
test('unprepared, wrong source, UUID and recovery target fail', () => {
  for (const mutate of [
    (w) => {
      w.result = 'preparing';
    },
    (w) => {
      w.clusterUid = 'other';
    },
    (w) => {
      w.sourceSystemId = '99999';
    },
    (w) => {
      w.sourceClusterUid = 'other';
    },
    (w) => {
      w.beforeId = w.afterId;
    },
    (w) => {
      w.afterId = "'; DROP SCHEMA public; --";
    },
    (w) => {
      w.archivedWalSegment = '';
    },
  ]) {
    const w = structuredClone(witness);
    mutate(w);
    assert.throws(() => validateWitness(w, c, source));
  }
  assert.throws(() => validateWitness(witness, c, source, '2026-01-01T10:01:01Z'), /target/);
});
test('incomplete, duplicate, post-backup before markers and pre-target after markers fail', () => {
  for (const mutate of [
    (w) => {
      w.databases.pop();
    },
    (w) => {
      w.databases[1].database = 'temporal';
    },
    (w) => {
      w.databases[0].beforeTime = w.backupCompletedAt;
    },
    (w) => {
      w.databases[0].afterTime = w.targetTime;
    },
    (w) => {
      w.backupCompletedAt = w.targetTime;
    },
  ]) {
    const w = structuredClone(witness);
    mutate(w);
    assert.throws(() => validateWitness(w, c, source), /bracket|backup/);
  }
});
test('restored included and excluded rows verify each database', () => {
  for (const row of witness.databases)
    assert.deepEqual(
      validateWitnessRows(witness, row.database, {
        database: row.database,
        before: 1,
        after: 0,
        beforeTime: row.beforeTime,
      }),
      { database: row.database, includedBefore: true, excludedAfter: true }
    );
});
test('empty databases and recovery past target cannot satisfy row proof', () => {
  const proof = { database: 'temporal', before: 1, after: 0, beforeTime: witness.databases[0].beforeTime };
  for (const mutate of [
    (p) => {
      p.before = 0;
    },
    (p) => {
      p.after = 1;
    },
    (p) => {
      p.database = 'temporal_visibility';
    },
    (p) => {
      p.beforeTime = '2025-01-01T00:00:00Z';
    },
  ]) {
    const p = structuredClone(proof);
    mutate(p);
    assert.throws(() => validateWitnessRows(witness, 'temporal', p), /witness/);
  }
});
test('canary writes only an ops-only schema and UUID validation prevents SQL injection', () => {
  const statement = markerSql(witness.beforeId, 'before');
  assert.match(statement, /CREATE SCHEMA IF NOT EXISTS temporal_restore_probe/);
  assert.match(statement, /REVOKE ALL ON SCHEMA temporal_restore_probe FROM PUBLIC/);
  assert.ok(!statement.includes('INSERT INTO public.'));
  assert.match(witnessQuery(witness), /temporal_restore_probe.witnesses/);
  assert.throws(() => markerSql("';DROP TABLE executions;--", 'before'), /UUID|marker/);
  assert.throws(() => witnessQuery({ ...witness, beforeId: "'" }), /UUID/);
});

test('physical cluster and ready source identity gates reject a misdirected preparation', () => {
  const ready = {
    ...source,
    status: { ...source.status, currentPrimary: 'postgres-1', conditions: [{ type: 'Ready', status: 'True' }] },
  };
  validateWitnessSource(c, { metadata: { uid: c.clusterUid } }, ready);
  assert.throws(() => validateWitnessSource(c, { metadata: { uid: 'other-cluster' } }, ready), /UID/);
  assert.throws(() => validateWitnessSource(c, { metadata: { uid: c.clusterUid } }, source), /ready/);
});
