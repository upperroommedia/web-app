#!/usr/bin/env node
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateConfig } from './temporal-platform.mjs';

export const WITNESS_DATABASES = ['temporal', 'temporal_visibility'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateWitness(witness, config, sourceCluster, targetTime = witness?.targetTime) {
  const target = Date.parse(targetTime);
  if (
    witness?.schemaVersion !== 1 ||
    witness.result !== 'prepared' ||
    !UUID.test(witness.beforeId ?? '') ||
    !UUID.test(witness.afterId ?? '') ||
    witness.beforeId === witness.afterId ||
    !Number.isFinite(target) ||
    target !== Date.parse(witness.targetTime) ||
    target >= Date.now()
  )
    throw new Error('Invalid restore witness or mismatched recovery target');
  if (
    witness.environment !== config.environment ||
    witness.clusterUid !== config.clusterUid ||
    witness.postgresHost !== config.postgresHost ||
    !witness.sourceClusterUid ||
    !/^\d+$/.test(witness.sourceSystemId ?? '') ||
    (sourceCluster &&
      (witness.sourceClusterUid !== sourceCluster.metadata?.uid ||
        witness.sourceSystemId !== sourceCluster.status?.systemID))
  )
    throw new Error('Restore witness source identity mismatch');
  if (
    !witness.sourceBackup ||
    !Number.isFinite(Date.parse(witness.backupCompletedAt)) ||
    Date.parse(witness.backupCompletedAt) >= target ||
    !/^[0-9A-F]{24}$/.test(witness.archivedWalSegment ?? '')
  )
    throw new Error('Restore witness has no completed pre-target backup and archived WAL');
  if (
    !Array.isArray(witness.databases) ||
    witness.databases.length !== 2 ||
    new Set(witness.databases.map((row) => row.database)).size !== 2 ||
    witness.databases.some(
      (row) =>
        !WITNESS_DATABASES.includes(row.database) ||
        !Number.isFinite(Date.parse(row.beforeTime)) ||
        Date.parse(row.beforeTime) >= Date.parse(witness.backupCompletedAt) ||
        !Number.isFinite(Date.parse(row.afterTime)) ||
        Date.parse(row.afterTime) <= target
    )
  )
    throw new Error('Restore witness must bracket its target in both databases');
  return witness;
}
export function validateWitnessSource(c, kubeNamespace, source) {
  if (kubeNamespace?.metadata?.uid !== c.clusterUid) throw new Error('Cluster UID mismatch');
  if (
    !source?.metadata?.uid ||
    !source.status?.currentPrimary ||
    !source.status?.conditions?.some((row) => row.type === 'Ready' && row.status === 'True') ||
    !/^\d+$/.test(source.status?.systemID ?? '')
  )
    throw new Error('Source cluster must be ready with known PostgreSQL identity');
}

export function witnessQuery(witness) {
  if (!UUID.test(witness.beforeId ?? '') || !UUID.test(witness.afterId ?? '')) throw new Error('Invalid witness UUID');
  return `SELECT json_build_object('database',current_database(),'before',(SELECT count(*) FROM temporal_restore_probe.witnesses WHERE id='${witness.beforeId}'::uuid AND marker='before'),'after',(SELECT count(*) FROM temporal_restore_probe.witnesses WHERE id='${witness.afterId}'::uuid AND marker='after'),'beforeTime',(SELECT recorded_at FROM temporal_restore_probe.witnesses WHERE id='${witness.beforeId}'::uuid AND marker='before'))`;
}
export function validateWitnessRows(witness, database, proof) {
  const expected = witness.databases.find((row) => row.database === database);
  if (
    !expected ||
    proof?.database !== database ||
    proof.before !== 1 ||
    proof.after !== 0 ||
    Date.parse(proof.beforeTime) !== Date.parse(expected.beforeTime)
  )
    throw new Error(`Recovered ${database} does not contain the included witness and exclude the post-target witness`);
  return { database, includedBefore: true, excludedAfter: true };
}
export function markerSql(id, marker) {
  if (!UUID.test(id ?? '') || !['before', 'after'].includes(marker)) throw new Error('Invalid probe marker');
  return `BEGIN; CREATE SCHEMA IF NOT EXISTS temporal_restore_probe; REVOKE ALL ON SCHEMA temporal_restore_probe FROM PUBLIC; CREATE TABLE IF NOT EXISTS temporal_restore_probe.witnesses (id uuid NOT NULL, marker text NOT NULL CHECK (marker IN ('before','after')), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(id,marker)); INSERT INTO temporal_restore_probe.witnesses(id,marker) VALUES ('${id}'::uuid,'${marker}'); COMMIT; SELECT json_build_object('recordedAt',recorded_at) FROM temporal_restore_probe.witnesses WHERE id='${id}'::uuid AND marker='${marker}';`;
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const apply = args.includes('--apply');
  const values = args.filter((arg) => arg !== '--apply');
  const flags = Object.fromEntries(
    Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]])
  );
  if (action !== 'prepare' || !apply || !flags['--config'] || !flags['--peer'] || !flags['--output'])
    throw new Error(
      'Usage: temporal-restore-witness.mjs prepare --config PATH --peer PATH --output PRIVATE_JSON --apply'
    );
  const c = validateConfig(
    JSON.parse(await readFile(flags['--config'], 'utf8')),
    JSON.parse(await readFile(flags['--peer'], 'utf8'))
  );
  try {
    await access(flags['--output']);
    throw new Error('Witness output already exists; choose a new private path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (c.databaseMode !== 'self-hosted')
    throw new Error('Witness preparation requires the reviewed self-hosted cluster');
  const run = (args, object) =>
    execFileSync('kubectl', ['--context', c.context, ...args], {
      input: object ? JSON.stringify(object) : undefined,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_700_000,
    });
  const json = (args) => JSON.parse(run([...args, '-o', 'json']));
  const kubeNamespace = json(['get', 'namespace', 'kube-system']);
  if (kubeNamespace.metadata.uid !== c.clusterUid) throw new Error('Cluster UID mismatch');
  const source = json(['get', 'cluster', 'temporal-postgres', '-n', c.namespace]);
  validateWitnessSource(c, kubeNamespace, source);
  const primary = source.status?.currentPrimary;
  const sql = (database, statement) =>
    run([
      'exec',
      '-n',
      c.namespace,
      primary,
      '-c',
      'postgres',
      '--',
      'psql',
      '-X',
      '-A',
      '-t',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      database,
      '-c',
      statement,
    ]).trim();
  const beforeId = randomUUID();
  const afterId = randomUUID();
  const databases = [];
  for (const database of WITNESS_DATABASES)
    databases.push({ database, beforeTime: JSON.parse(sql(database, markerSql(beforeId, 'before'))).recordedAt });
  const backup = JSON.parse(
    run(['create', '-f', '-', '-o', 'json'], {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Backup',
      metadata: { generateName: 'temporal-witness-', namespace: c.namespace },
      spec: {
        cluster: { name: 'temporal-postgres' },
        method: 'plugin',
        pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
      },
    })
  );
  run([
    'wait',
    '--for=jsonpath={.status.phase}=completed',
    `backup/${backup.metadata.name}`,
    '-n',
    c.namespace,
    '--timeout=3600s',
  ]);
  const completed = json(['get', 'backup', backup.metadata.name, '-n', c.namespace]);
  const targetTime = new Date(
    JSON.parse(sql('postgres', "SELECT json_build_object('time',clock_timestamp())")).time
  ).toISOString();
  // Explicitly cross the target using PostgreSQL's own clock, independent of operator clock skew.
  sql('postgres', 'SELECT pg_sleep(0.05)');
  for (const row of databases) row.afterTime = JSON.parse(sql(row.database, markerSql(afterId, 'after'))).recordedAt;
  const archivedWalSegment = sql('postgres', 'SELECT pg_walfile_name(pg_current_wal_insert_lsn())');
  if (!/^[0-9A-F]{24}$/.test(archivedWalSegment)) throw new Error('Invalid WAL segment identity');
  sql('postgres', 'SELECT pg_switch_wal()');
  const deadline = Date.now() + 180_000;
  while (
    sql(
      'postgres',
      `SELECT COALESCE(left(last_archived_wal,8) = '${archivedWalSegment.slice(
        0,
        8
      )}' AND last_archived_wal >= '${archivedWalSegment}',false) FROM pg_stat_archiver`
    ) !== 't'
  ) {
    if (Date.now() >= deadline)
      throw new Error('Post-target witness WAL was not archived; no recovery proof was issued');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const currentSource = json(['get', 'cluster', 'temporal-postgres', '-n', c.namespace]);
  if (
    currentSource.status?.currentPrimary !== primary ||
    currentSource.metadata.uid !== source.metadata.uid ||
    currentSource.status?.systemID !== source.status.systemID
  )
    throw new Error('Source primary or identity changed during witness preparation; retry a fresh drill');
  const witness = {
    schemaVersion: 1,
    result: 'prepared',
    environment: c.environment,
    clusterUid: c.clusterUid,
    postgresHost: c.postgresHost,
    sourceClusterUid: source.metadata.uid,
    sourceSystemId: source.status.systemID,
    sourceBackup: backup.metadata.name,
    backupCompletedAt: completed.status.stoppedAt,
    targetTime,
    beforeId,
    afterId,
    databases,
    archivedWalSegment,
    preparedAt: new Date().toISOString(),
  };
  validateWitness(witness, c, source);
  await writeFile(flags['--output'], JSON.stringify(witness, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(
    JSON.stringify({
      result: 'prepared',
      targetTime,
      sourceBackup: witness.sourceBackup,
      witnessPath: flags['--output'],
    })
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
