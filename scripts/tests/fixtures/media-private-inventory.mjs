import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { nativeSnapshotProof, proofDigest as hash } from '../../temporal-release-runtime.mjs';
const require = createRequire(import.meta.url),
  { Timestamp } = require('firebase-admin/firestore');
export function mediaPrivateInventoryFixture() {
  const id = randomUUID(),
    buildId = 'a'.repeat(40),
    oldBuild = 'b'.repeat(40),
    releaseId = randomUUID(),
    namespace = 'urm-app-staging.qwejt',
    deploymentName = 'urm-worker-media-recovery-staging',
    queue = 'urm-media-kernel-recovery';
  const plan = {
      operationId: id,
      role: 'media',
      releaseId,
      buildId,
      name: 'projects/urm-app-staging/locations/us-central1/workerPools/owned',
      image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'c'.repeat(64)}`,
      runner: 'owned@urm-app-staging.iam.gserviceaccount.com',
      contract: { deploymentName, queue },
    },
    pool = { desiredManualInstanceCount: 1, revision: `${plan.name}/revisions/owned.2`, revisionUid: 'owned-uid' };
  const cloudRun = {
      projectId: 'urm-app-staging',
      region: 'us-central1',
      pool: 'owned',
      revision: 'owned.2',
      revisionUid: 'owned-uid',
      imageDigest: plan.image.split('@')[1],
      serviceAccount: plan.runner,
      instanceId: 'same-container',
    },
    parent = { instanceId: randomUUID(), buildId, cloudRun };
  const docs = new Map(),
    rows = new Map(),
    calls = [];
  const state = { pendingPolls: 0, missingPollers: false, extraQueue: false, open: false };
  const add = (path, value) => docs.set(path, value),
    control = {
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((k) => [
          k,
          { admission: 'paused' },
        ])
      ),
    };
  add('_control/temporalReleaseOperation', {
    action: 'diagnose-cloud-run-media-recovery',
    operationId: id,
    releaseId,
    bindingDigest: 'd'.repeat(64),
    cloudMediaRecovery: {
      stage: 'recovered',
      plan,
      start: { stage: 'completed', pool },
      recovery: { proofSHA256: 'e'.repeat(64) },
    },
  });
  add('_control/temporalRelease', control);
  add('_control/temporalReleaseState', { releaseId, phase: 'provider-usage-ready' });
  for (const k of ['Kernel', 'ReplacementKernel'])
    add(`_control/temporalMediaRecovery${k}-${id}`, {
      schemaVersion: 1,
      stage: 'closed',
      context: { operationId: id, intentSHA256: 'f'.repeat(64), parent },
      worker: { instanceId: randomUUID(), buildId, cloudRun },
      close: { code: 0, signal: k === 'Kernel' ? 'SIGKILL' : null, descendantsAbsent: true },
    });
  add(`_control/temporalMediaRecoveryReplacementIntent-${id}`, {});
  const snapshot = (path) => ({
    exists: docs.has(path),
    ref: { path },
    data: () => docs.get(path),
    get: (p) => p.split('.').reduce((a, k) => a?.[k], docs.get(path)),
    createTime: new Timestamp(1, 0),
    updateTime: new Timestamp(1, 0),
  });
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path }),
    runTransaction: async (fn) => fn({ get: async (r) => snapshot(r.path) }),
    collection: (name) => {
      const q = {
        orderBy: () => q,
        limit: () => q,
        startAfter: () => q,
        get: async () => {
          const ds = (rows.get(name) ?? []).map((v, i) => {
            const path = `${name}/${i}`;
            add(path, v);
            return snapshot(path);
          });
          return { docs: ds, size: ds.length };
        },
      };
      return q;
    },
  };
  const service = {
    listActivityExecutions: async () => ({ executions: [] }),
    listNexusOperationExecutions: async () => ({ operations: [] }),
    listWorkerDeployments: async () => ({ workerDeployments: [{ name: deploymentName }] }),
    describeWorkerDeployment: async () => ({
      workerDeploymentInfo: {
        name: deploymentName,
        routingConfig: {},
        versionSummaries: [buildId, oldBuild].map((buildId) => ({ deploymentVersion: { deploymentName, buildId } })),
      },
    }),
    describeWorkerDeploymentVersion: async (r) => ({
      workerDeploymentVersionInfo: {
        deploymentVersion: r.deploymentVersion,
        taskQueueInfos: [1, 2].map((type) => ({ name: queue, type })),
        computeConfig: null,
      },
      versionTaskQueues: [1, 2].map((type) => ({ name: queue, type, stats: { approximateBacklogCount: 0 } })),
    }),
    listTaskQueuePartitions: async (r) => {
      assert.deepEqual(r.taskQueue, { name: queue, kind: 1 });
      return {
        workflowTaskQueuePartitions: [{ key: queue }, { key: `/_sys/${queue}/1` }],
        activityTaskQueuePartitions: [{ key: queue }],
      };
    },
    describeTaskQueue: async (r) => {
      calls.push(r);
      return state.missingPollers
        ? {}
        : {
            taskQueueStatus: { backlogCountHint: 0 },
            pollers:
              state.pendingPolls-- > 0
                ? [{ identity: 'older-version', deploymentOptions: { deploymentName, buildId: oldBuild } }]
                : [],
          };
    },
    listWorkflowExecutions: async () => ({
      executions: state.open ? [{ execution: { workflowId: 'external', runId: id } }] : [],
    }),
    describeWorkflowExecution: async () => ({
      workflowExecutionInfo: {
        execution: { workflowId: 'external', runId: id },
        status: 1,
        taskQueue: 'unrelated',
        versioningInfo: { behavior: 1, deploymentVersion: { deploymentName: 'old', buildId: oldBuild } },
      },
      pendingActivities: [{ activityId: 'private-work' }],
    }),
  };
  const client = {
    options: { namespace },
    connection: { workflowService: service, withDeadline: async (_d, fn) => fn() },
  };
  const lockRef = db.doc('_control/temporalReleaseOperation'),
    controlRef = db.doc('_control/temporalRelease'),
    stateRef = db.doc('_control/temporalReleaseState');
  return {
    docs,
    snapshot,
    rows,
    calls,
    state,
    options: {
      client,
      firestore: db,
      plan,
      pool,
      operationId: id,
      bindingDigest: 'd'.repeat(64),
      lockRef,
      controlRef,
      stateRef,
      ownedOperation: nativeSnapshotProof(snapshot(lockRef.path)),
      expectedAuthority: {
        control: nativeSnapshotProof(snapshot(controlRef.path)),
        state: nativeSnapshotProof(snapshot(stateRef.path)),
      },
    },
  };
}
