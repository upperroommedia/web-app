// Controlled Storage IAM response, with the real receipt writer and collector.
jest.mock('../runtime/cloud-run-storage-readiness', () => {
  const actual = jest.requireActual('../runtime/cloud-run-storage-readiness');
  return {
    ...actual,
    verifyCloudRunStorageReadiness: jest.fn(async (role) => {
      const expected = actual.expectedCloudRunStorageAccess(role);
      return expected ? { ...expected, observedAt: new Date().toISOString() } : null;
    }),
  };
});
// Explicit no-network email fixture; local tests do not prove deployed mail authentication.
jest.mock('@upperroom/function-kit-firestore-send-email/lib/temporal/provider', () => ({
  verifyEmailTransportNoSendBounded: jest.fn(async () => ({
    provider: 'smtp',
    tlsVerified: true,
    authenticationVerified: true,
    mailPermissionVerified: false,
    noMessageSent: true,
    observedAt: new Date().toISOString(),
  })),
}));
// Controlled serving-read fixture, alongside the controlled Cloud Run identity.
// Native SDK execution/Firestore receipts here do NOT prove deployed RTDB access.
jest.mock('../runtime/cloud-run-rtdb-readiness', () => ({
  verifyCloudRunRtdbReadiness: jest.fn(async () => ({
    databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
    readPath: 'bundle-metadata',
    readSucceeded: true,
    observedAt: new Date().toISOString(),
  })),
}));
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
import { Worker } from '@temporalio/worker';
import { createWorkerReadinessActivities, WORKER_READINESS_COLLECTION } from '../runtime/readiness-probe';
import type { WorkerRuntimeProbe } from '../workflows/verification/runtime';
import type { WorkerWitness } from '../runtime/worker-witness';

/** Real local Temporal + dedicated Firestore emulator. The controlled cloudRun
 * fixture tests receipt plumbing; it is NOT a Cloud Run identity attestation. */
test('fresh native role executions persist private witnesses and return only receipt hashes', async () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  const port = config.emulators.firestore.port;
  if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
    throw new Error('Dedicated firebase.test.json emulator harness required');
  const app = initializeApp({ projectId: 'urm-app-staging' }, `readiness-${randomUUID()}`);
  const db = getFirestore(app);
  const environment = await createLocalTestEnvironment();
  const workers: Worker[] = [],
    running: Promise<void>[] = [];
  const buildId = 'a'.repeat(40),
    nonce = randomUUID().replaceAll('-', '');
  const ownedNonces = [nonce];
  let conflictReceipt: { id: string; digest: string } | undefined;
  const witness = (role: string): WorkerWitness => ({
    buildId,
    instanceId: `process-${role}`,
    cloudRun: {
      projectId: 'urm-app-staging',
      region: 'us-central1',
      pool: `pool-${role}`,
      revision: `pool-${role}-00001`,
      revisionUid: `uid-${role}`,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      serviceAccount: `${role}@urm-app-staging.iam.gserviceaccount.com`,
      instanceId: `native-${role}`,
    },
  });
  try {
    for (const role of ['orchestration', 'controls', 'images', 'email']) {
      const queue = `urm-${role}`;
      const activities = createWorkerReadinessActivities({
        workflowBundle: { schemaVersion: 1, buildId, bundleSHA256: 'f'.repeat(64), bundleBytes: 100 },
        firestore: db,
        projectId: 'urm-app-staging',
        buildId,
        queue,
        witness:
          role === 'images'
            ? { ...witness(role), cloudRun: { ...witness(role).cloudRun!, projectId: 'urm-app' } }
            : witness(role),
      });
      if (role === 'email') {
        // Real native context + real SDK create conflict, no fake execution context.
        const record = activities.recordWorkerReadiness;
        activities.recordWorkerReadiness = async (request) => {
          conflictReceipt = await record(request);
          return record(request);
        };
      }
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: queue,
        workflowsPath: role === 'orchestration' ? require.resolve('../workflows/verification/runtime') : undefined,
        activities,
      });
      workers.push(worker);
      running.push(worker.run());
    }
    const handle = await environment.client.workflow.start<typeof WorkerRuntimeProbe>('WorkerRuntimeProbe', {
      taskQueue: 'urm-orchestration',
      workflowId: `serverless-readiness-${nonce}`,
      args: [{ projectId: 'urm-app-staging', buildId, nonce, roles: ['orchestration', 'controls'] }],
      workflowExecutionTimeout: '30 seconds',
    });
    const result = await handle.result();
    expect(Object.keys(result)).toEqual(['orchestration', 'controls']);
    for (const role of ['orchestration', 'controls']) {
      expect(Object.keys(result[role]).sort()).toEqual(['digest', 'id']);
      expect(result[role].id).toMatch(/^[a-f0-9]{64}$/);
      const stored = await db.collection(WORKER_READINESS_COLLECTION).doc(result[role].id).get();
      expect(stored.get('digest')).toBe(result[role].digest);
      expect(stored.get('runId')).toBe(handle.firstExecutionRunId);
      expect(stored.get('worker.cloudRun.instanceId')).toBe(`native-${role}`);
      expect(stored.get('taskQueue')).toBe(`urm-${role}`);
      expect(stored.get('attempt')).toBe(1);
    }
    const history = await handle.fetchHistory();
    const payloads: string[] = [];
    const inspect = (value: unknown): void => {
      if (value instanceof Uint8Array) {
        payloads.push(Buffer.from(value).toString('utf8'));
        return;
      }
      if (value && typeof value === 'object') for (const item of Object.values(value)) inspect(item);
    };
    inspect(history);
    const text = payloads.join('\n');
    expect(text).not.toContain('native-controls');
    expect(text).not.toContain('uid-orchestration');
    expect(text).not.toContain('@urm-app-staging.iam.gserviceaccount.com');
    const conflictNonce = randomUUID().replaceAll('-', '');
    ownedNonces.push(conflictNonce);
    const conflict = await environment.client.workflow.start('WorkerRuntimeProbe', {
      taskQueue: 'urm-orchestration',
      workflowId: `serverless-readiness-${conflictNonce}`,
      args: [{ projectId: 'urm-app-staging', buildId, nonce: conflictNonce, roles: ['email'] }],
      workflowExecutionTimeout: '10 seconds',
    });
    await expect(conflict.result()).rejects.toThrow();
    const failedHistory = await conflict.fetchHistory();
    expect(
      failedHistory.events?.find((event) => event.activityTaskFailedEventAttributes)?.activityTaskFailedEventAttributes
        ?.failure?.message
    ).toBe('WORKER_READINESS_EVIDENCE_UNCONFIRMED');
    expect(conflictReceipt).toBeDefined();
    expect((await db.collection(WORKER_READINESS_COLLECTION).doc(conflictReceipt!.id).get()).get('digest')).toBe(
      conflictReceipt!.digest
    );
    const rejectedNonce = randomUUID().replaceAll('-', '');
    ownedNonces.push(rejectedNonce);
    const rejected = await environment.client.workflow.start('WorkerRuntimeProbe', {
      taskQueue: 'urm-orchestration',
      workflowId: `serverless-readiness-${rejectedNonce}`,
      args: [{ projectId: 'urm-app-staging', buildId, nonce: rejectedNonce, roles: ['images'] }],
      workflowExecutionTimeout: '10 seconds',
    });
    await expect(rejected.result()).rejects.toThrow();
    expect((await db.collection(WORKER_READINESS_COLLECTION).where('nonce', '==', rejectedNonce).get()).empty).toBe(
      true
    );
    const invalidNonce = randomUUID().replaceAll('-', '');
    ownedNonces.push(invalidNonce);
    const bad = await environment.client.workflow.start('WorkerRuntimeProbe', {
      taskQueue: 'urm-orchestration',
      workflowId: `serverless-readiness-${invalidNonce}`,
      args: [{ projectId: 'urm-app-staging', buildId, nonce: invalidNonce, roles: ['controls', 'controls'] }],
      workflowExecutionTimeout: '10 seconds',
    });
    await expect(bad.result()).rejects.toThrow();
    expect((await db.collection(WORKER_READINESS_COLLECTION).where('nonce', '==', invalidNonce).get()).empty).toBe(
      true
    );
  } finally {
    for (const worker of workers) if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
    await Promise.allSettled(running);
    await environment.teardown();
    const evidence = await db.collection(WORKER_READINESS_COLLECTION).where('nonce', 'in', ownedNonces).get();
    for (const doc of evidence.docs) await doc.ref.delete();
    await db.terminate();
    await deleteApp(app);
  }
}, 60000);
