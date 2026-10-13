#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateWitness, witnessQuery, validateWitnessRows } from './temporal-restore-witness.mjs';
import { validateConfig, databaseCluster, databaseNetworkPolicy } from './temporal-platform.mjs';
// Versions and tables are tied to the pinned Temporal Server 1.32.1 schema.
// https://github.com/temporalio/temporal/blob/v1.32.1/schema/postgresql/v12/version.go
export const RESTORE_SCHEMAS = {
  temporal: {
    version: '1.19',
    tables: [
      'schema_version',
      'schema_update_history',
      'namespaces',
      'namespace_metadata',
      'shards',
      'executions',
      'current_executions',
      'history_node',
      'history_tree',
      'task_queues_v2',
      'cluster_metadata_info',
    ],
  },
  temporal_visibility: {
    version: '1.14',
    tables: ['schema_version', 'schema_update_history', 'executions_visibility'],
  },
};

export function schemaProofSql(database) {
  if (!RESTORE_SCHEMAS[database]) throw new Error('Unexpected database');
  return `SELECT json_build_object('database',current_database(),'systemId',(SELECT system_identifier::text FROM pg_control_system()),'tables',(SELECT json_agg(tablename ORDER BY tablename) FROM pg_catalog.pg_tables WHERE schemaname='public'),'markers',(SELECT json_agg(json_build_object('database',db_name,'partition',version_partition,'version',curr_version,'minimumVersion',min_compatible_version,'createdAt',creation_time)) FROM public.schema_version))`;
}

export function validateSystemIdentity(proof, sourceSystemId) {
  if (!/^\d+$/.test(sourceSystemId ?? '') || proof?.systemId !== sourceSystemId)
    throw new Error('Recovered database system identifier differs from the source archive cluster');
}

export function validateSchemaProof(database, proof) {
  const expected = RESTORE_SCHEMAS[database];
  if (
    !expected ||
    proof?.database !== database ||
    !Array.isArray(proof.tables) ||
    expected.tables.some((table) => !proof.tables.includes(table))
  )
    throw new Error(`Recovered ${database} is missing expected Temporal tables`);
  const markers = proof.markers?.filter((marker) => marker.database === database && marker.partition === 0);
  const marker = markers?.[0];
  if (
    markers?.length !== 1 ||
    marker.version !== expected.version ||
    !/^\d+\.\d+$/.test(marker.minimumVersion ?? '') ||
    !Number.isFinite(Date.parse(marker.createdAt))
  )
    throw new Error(`Recovered ${database} has no valid pinned schema bootstrap marker`);
  const compare = (a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    return x[0] - y[0] || x[1] - y[1];
  };
  if (compare(marker.minimumVersion, marker.version) > 0) throw new Error('Invalid minimum compatible schema version');
  return { database, version: marker.version, minimumVersion: marker.minimumVersion, tableCount: proof.tables.length };
}

export function validateRestoreIdentity(c, restored, objectStore, sourceCluster, backups, now = Date.now()) {
  const recovery = restored.spec?.bootstrap?.recovery;
  const target = recovery?.recoveryTarget;
  const targetMs = Date.parse(target?.targetTime);
  if (
    !Number.isFinite(targetMs) ||
    targetMs >= now ||
    Object.keys(target).some((key) => !['targetTime', 'exclusive', 'targetTLI'].includes(key))
  )
    throw new Error('Restore requires an unambiguous explicit past time target');
  const sources = restored.spec.externalClusters?.filter((source) => source.name === 'source');
  const plugin = sources?.[0]?.plugin;
  if (
    restored.spec.plugins?.length ||
    recovery.source !== 'source' ||
    sources?.length !== 1 ||
    plugin?.name !== 'barman-cloud.cloudnative-pg.io' ||
    plugin.parameters?.barmanObjectName !== 'temporal-backups' ||
    plugin.parameters?.serverName !== 'temporal-postgres'
  )
    throw new Error('Restore archive source identity does not match the original cluster');
  const configuration = objectStore?.spec?.configuration;
  if (
    objectStore?.metadata?.name !== 'temporal-backups' ||
    configuration?.destinationPath !== c.backupDestination ||
    configuration?.endpointURL !== c.backupEndpoint ||
    configuration?.s3Credentials?.accessKeyId?.name !== 'temporal-restore-objectstore' ||
    configuration?.s3Credentials?.secretAccessKey?.name !== 'temporal-restore-objectstore'
  )
    throw new Error('Restore archive must match the configured source and use restore-only credentials');
  if (
    !sourceCluster?.metadata?.uid ||
    !/^\d+$/.test(sourceCluster.status?.systemID ?? '') ||
    !Number.isFinite(Date.parse(sourceCluster.metadata.creationTimestamp))
  )
    throw new Error('Source cluster identity is missing');
  const eligible = backups.filter(
    (backup) =>
      backup.spec?.cluster?.name === 'temporal-postgres' &&
      backup.spec?.method === 'plugin' &&
      backup.spec?.pluginConfiguration?.name === 'barman-cloud.cloudnative-pg.io' &&
      backup.status?.phase === 'completed' &&
      Date.parse(backup.metadata?.creationTimestamp) >= Date.parse(sourceCluster.metadata.creationTimestamp) &&
      Number.isFinite(Date.parse(backup.status.stoppedAt)) &&
      Date.parse(backup.status.stoppedAt) <= targetMs
  );
  if (!eligible.length) throw new Error('No completed source-cluster base backup exists before the recovery target');
  const backup = eligible.sort((a, b) => Date.parse(a.status.stoppedAt) - Date.parse(b.status.stoppedAt)).at(-1);
  return {
    targetTime: new Date(targetMs).toISOString(),
    exclusive: target.exclusive === true,
    sourceClusterUid: sourceCluster.metadata.uid,
    sourceSystemId: sourceCluster.status.systemID,
    sourceBackup: backup.metadata.name,
    sourceBackupCompletedAt: backup.status.stoppedAt,
    archiveDestination: configuration.destinationPath,
    archiveEndpoint: configuration.endpointURL,
  };
}

export function restoreNetworkPolicy(c, namespace) {
  const policy = databaseNetworkPolicy(c, namespace, 'temporal-postgres-restore');
  // Restore queries stay inside the isolated namespace; application/server peers are excluded.
  for (const rule of policy.spec.ingress)
    rule.from = rule.from.filter((peer) => !peer.podSelector?.matchLabels?.['app.kubernetes.io/name']);
  return policy;
}

// PostgreSQL 18 only emits the stop-before transaction message after reaching the
// configured time boundary. A ready/promoted cluster alone does not prove PITR.
// https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/access/transam/xlogrecovery.c
export function validateRecoveryLog(log, identity) {
  const messages = log.split('\n').map((line) => {
    try {
      const record = JSON.parse(line);
      return record.logger === 'postgres' ? record.record?.message ?? '' : '';
    } catch {
      return '';
    }
  });
  const start = messages.findLastIndex((message) => message.startsWith('starting point-in-time recovery to '));
  if (
    start < 0 ||
    Date.parse(messages[start].slice('starting point-in-time recovery to '.length)) !== Date.parse(identity.targetTime)
  )
    throw new Error('PostgreSQL recovery log does not prove the requested time target was used');
  const recovery = messages.slice(start + 1);
  if (recovery.some((message) => message.includes('recovery ended before configured recovery target was reached')))
    throw new Error('Recovery ended before its target');
  const stop = recovery.find((message) =>
    /^recovery stopping before (commit|abort) of transaction \d+, time /.test(message)
  );
  const stoppedAt = stop && Date.parse(stop.slice(stop.indexOf(', time ') + 7));
  const target = Date.parse(identity.targetTime);
  if (!Number.isFinite(stoppedAt) || (identity.exclusive ? stoppedAt < target : stoppedAt <= target))
    throw new Error('PostgreSQL recovery log does not prove the time boundary was reached');
  return { targetReached: true, firstExcludedTransactionTime: new Date(stoppedAt).toISOString() };
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const apply = args.includes('--apply');
  const values = args.filter((a) => a !== '--apply');
  const flags = Object.fromEntries(
    Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]])
  );
  if (!['backup', 'render-restore', 'verify-restore'].includes(action) || !flags['--config'] || !flags['--peer'])
    throw new Error(
      'Usage: temporal-backup.mjs backup|render-restore|verify-restore --config PATH --peer PATH [--apply] [--restore-namespace NAME] [--target-time ISO] [--witness PRIVATE_JSON] [--output PATH]'
    );
  const c = validateConfig(
    JSON.parse(await readFile(flags['--config'], 'utf8')),
    JSON.parse(await readFile(flags['--peer'], 'utf8'))
  );
  if (c.databaseMode !== 'self-hosted')
    throw new Error('For existing-ha databases use the provider PITR API and isolated restore procedure');
  const run = (args, object) =>
    execFileSync('kubectl', ['--context', c.context, ...args], {
      input: object ? JSON.stringify(object) : undefined,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_700_000,
    });
  const json = (args) => JSON.parse(run([...args, '-o', 'json']));
  const witness =
    action === 'backup' ? null : flags['--witness'] ? JSON.parse(await readFile(flags['--witness'], 'utf8')) : null;
  if (action !== 'backup' && !witness)
    throw new Error('Render and verify restore require --witness from an explicit prepared PITR drill');
  if (witness) validateWitness(witness, c, undefined, flags['--target-time'] ?? witness.targetTime);
  if (action === 'render-restore') {
    const namespace = flags['--restore-namespace'];
    const target = flags['--target-time'] ?? witness.targetTime;
    if (!/^temporal-restore-[a-z0-9-]+$/.test(namespace ?? '') || namespace.length > 63 || namespace === c.namespace)
      throw new Error('Restore requires a distinct temporal-restore-* namespace');
    if (!target || !Number.isFinite(Date.parse(target)) || Date.parse(target) >= Date.now() || !flags['--output'])
      throw new Error('An explicit past target time and --output path are required');
    const source = databaseCluster(c);
    const db = source.items.find((i) => i.kind === 'Cluster');
    db.metadata.namespace = namespace;
    db.metadata.name = 'temporal-postgres-restore';
    db.spec.inheritedMetadata = {
      ...db.spec.inheritedMetadata,
      labels: { ...db.spec.inheritedMetadata?.labels, 'urm.temporal/database-network': 'temporal-postgres-restore' },
    };
    db.spec.bootstrap = {
      recovery: { source: 'source', recoveryTarget: { targetTime: new Date(target).toISOString() } },
    };
    db.spec.externalClusters = [
      {
        name: 'source',
        plugin: {
          name: 'barman-cloud.cloudnative-pg.io',
          parameters: { barmanObjectName: 'temporal-backups', serverName: 'temporal-postgres' },
        },
      },
    ];
    delete db.spec.plugins;
    // Restore readers receive a separate read-only object-store identity. No archiver writes to the source backup prefix.
    const objectStore = source.items.find((i) => i.kind === 'ObjectStore');
    objectStore.metadata.namespace = namespace;
    objectStore.spec.configuration.s3Credentials.accessKeyId.name = 'temporal-restore-objectstore';
    objectStore.spec.configuration.s3Credentials.secretAccessKey.name = 'temporal-restore-objectstore';
    delete objectStore.spec.retentionPolicy;
    const policy = restoreNetworkPolicy(c, namespace);
    const objects = [
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: namespace,
          labels: { 'urm.temporal/restore-only': 'true', 'pod-security.kubernetes.io/enforce': 'restricted' },
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'default-deny', namespace },
        spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
      },
      objectStore,
      db,
      policy,
    ];
    await writeFile(
      flags['--output'],
      JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }, null, 2) + '\n',
      { mode: 0o600 }
    );
    console.log(
      'Isolated PITR manifest rendered. It contains no application worker or Temporal server. Provision restore-only credentials before applying.'
    );
  } else {
    if (json(['get', 'namespace', 'kube-system']).metadata.uid !== c.clusterUid)
      throw new Error('Cluster UID mismatch');
    if (action === 'backup') {
      if (!apply) throw new Error('backup requires explicit --apply');
      const backup = jsonCreate({
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Backup',
        metadata: { generateName: 'temporal-manual-', namespace: c.namespace },
        spec: {
          cluster: { name: 'temporal-postgres' },
          method: 'plugin',
          pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
        },
      });
      run([
        'wait',
        '--for=jsonpath={.status.phase}=completed',
        `backup/${backup.metadata.name}`,
        '-n',
        c.namespace,
        '--timeout=3600s',
      ]);
      console.log(`Base backup completed: ${backup.metadata.name}. Restore verification is still required.`);
    } else {
      if (
        !flags['--restore-namespace'] ||
        !/^temporal-restore-[a-z0-9-]+$/.test(flags['--restore-namespace']) ||
        !flags['--output']
      )
        throw new Error('verify-restore requires isolated namespace and output path');
      const namespace = flags['--restore-namespace'];
      const resources = json(['get', 'deployments,statefulsets,jobs', '-n', namespace]).items;
      if (resources.length)
        throw new Error('Restore namespace must contain no application/server deployments, StatefulSets or jobs');
      const restored = json(['get', 'cluster', 'temporal-postgres-restore', '-n', namespace]);
      if (restored.spec.plugins?.length || restored.spec.bootstrap?.recovery?.source !== 'source')
        throw new Error('Restored cluster must be read-only with respect to the original backup archive');
      const primary = restored.status.currentPrimary;
      if (!primary || !restored.status.conditions?.some((s) => s.type === 'Ready' && s.status === 'True'))
        throw new Error('Restored cluster is not ready');
      const sql =
        "SELECT datname FROM pg_database WHERE datname IN ('temporal','temporal_visibility') ORDER BY datname";
      const databases = run([
        'exec',
        '-n',
        namespace,
        primary,
        '-c',
        'postgres',
        '--',
        'psql',
        '-X',
        '-A',
        '-t',
        '-d',
        'postgres',
        '-c',
        sql,
      ])
        .trim()
        .split('\n');
      if (databases.join(',') !== 'temporal,temporal_visibility')
        throw new Error('Both Temporal databases were not recovered');
      const sourceCluster = json(['get', 'cluster', 'temporal-postgres', '-n', c.namespace]);
      validateWitness(witness, c, sourceCluster, restored.spec.bootstrap.recovery.recoveryTarget?.targetTime);
      const schemaProofs = [];
      const witnessProofs = [];
      for (const database of databases) {
        const proof = JSON.parse(
          run([
            'exec',
            '-n',
            namespace,
            primary,
            '-c',
            'postgres',
            '--',
            'psql',
            '-X',
            '-A',
            '-t',
            '-v',
            'ON_ERROR_STOP=1',
            '-d',
            database,
            '-c',
            schemaProofSql(database),
          ])
        );
        validateSystemIdentity(proof, sourceCluster.status?.systemID);
        schemaProofs.push(validateSchemaProof(database, proof));
        const witnessRows = JSON.parse(
          run([
            'exec',
            '-n',
            namespace,
            primary,
            '-c',
            'postgres',
            '--',
            'psql',
            '-X',
            '-A',
            '-t',
            '-v',
            'ON_ERROR_STOP=1',
            '-d',
            database,
            '-c',
            witnessQuery(witness),
          ])
        );
        witnessProofs.push(validateWitnessRows(witness, database, witnessRows));
      }
      const objectStore = json(['get', 'objectstore.barmancloud.cnpg.io', 'temporal-backups', '-n', namespace]);
      const backups = json(['get', 'backups', '-n', c.namespace]).items;
      const identity = validateRestoreIdentity(c, restored, objectStore, sourceCluster, backups);
      if (
        identity.sourceBackup !== witness.sourceBackup ||
        Date.parse(identity.sourceBackupCompletedAt) !== Date.parse(witness.backupCompletedAt)
      )
        throw new Error('Restored archive proof does not match the prepared drill backup');
      const recoveryProof = validateRecoveryLog(run(['logs', '-n', namespace, primary, '-c', 'postgres']), identity);
      const evidence = {
        environment: c.environment,
        clusterUid: c.clusterUid,
        postgresHost: c.postgresHost,
        backupVerifiedAt: identity.sourceBackupCompletedAt,
        schemaProofs,
        witnessProofs,
        witnessIds: { before: witness.beforeId, after: witness.afterId },
        archiveSource: identity,
        recoveryProof,
        restoreVerifiedAt: new Date().toISOString(),
        isolatedRestore: true,
        bothDatabasesVerified: true,
        sideEffectsDisabled: true,
        result: 'passed',
        restoreNamespace: namespace,
        recoveryTarget: restored.spec.bootstrap.recovery.recoveryTarget,
        restoredClusterUid: restored.metadata.uid,
      };
      await writeFile(flags['--output'], JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      console.log(
        'Isolated restore verified; evidence written. Review external side-effect reconciliation before any production recovery.'
      );
    }
  }
  function jsonCreate(object) {
    return JSON.parse(run(['create', '-f', '-', '-o', 'json'], object));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
