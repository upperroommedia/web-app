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
import { msToTs } from '@temporalio/common/lib/time';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, realpath, rename, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
import {
  createWorkerReadinessActivities,
  WORKER_READINESS_COLLECTION,
  workerReadinessDigest,
} from '../runtime/readiness-probe';
import {
  collectServerlessRoleReadiness,
  reconcileServerlessRoleReadiness,
  collectServerlessReadinessObservations,
  type ServerlessRoleBinding,
} from '../runtime/serverless-release-readiness';

test('collector joins actual version routing, native activity history and private Firestore receipts', async () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  if (
    !new RegExp(`^(127\\.0\\.0\\.1|localhost):${config.emulators.firestore.port}$`).test(
      process.env.FIRESTORE_EMULATOR_HOST ?? ''
    )
  )
    throw new Error('Dedicated emulator required');
  const app = initializeApp({ projectId: 'urm-app-staging' }, `collector-${randomUUID()}`);
  const db = getFirestore(app),
    environment = await createLocalTestEnvironment();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'urm-collector-native-')));
  const workers: Worker[] = [],
    running: Promise<void>[] = [];
  const namespace = 'urm-app-staging.qwejt';
  const client = new Client({ connection: environment.connection, namespace });
  const buildId = 'a'.repeat(40),
    image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
  const bindings: ServerlessRoleBinding[] = ['orchestration', 'controls', 'email'].map((role, i) => ({
    projectId: 'urm-app-staging',
    region: 'us-central1',
    namespace,
    role: role as 'orchestration' | 'controls' | 'email',
    buildId,
    image,
    poolName: `urm-worker-${role}-${buildId.slice(0, 20)}`,
    deploymentName: i === 0 ? 'urm-worker-staging' : `urm-worker-${role}-staging`,
    runnerServiceAccount: `tw-${i === 0 ? 'o' : role === 'email' ? 'e' : 'c'}-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
  }));
  // Official-schema fixtures isolate Cloud Run GETs only. They are NOT real cloud attestations.
  const resources = new Map<string, unknown>();
  let proof: Awaited<ReturnType<typeof collectServerlessReadinessObservations>> | undefined;
  try {
    await environment.connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: msToTs(86400000),
    });
    for (const binding of bindings) {
      const parent = `projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.poolName}`;
      const revision = `${binding.poolName}-00001`,
        name = `${parent}/revisions/${revision}`;
      resources.set(parent, {
        name: parent,
        uid: `pool-uid-${binding.role}`,
        generation: '9007199254740993',
        observedGeneration: '9007199254740993',
        reconciling: false,
        terminalCondition: { state: 'CONDITION_SUCCEEDED' },
        latestReadyRevision: name,
        latestCreatedRevision: name,
        instanceSplits: [],
        instanceSplitStatuses: [{ type: 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST', revision: name, percent: 100 }],
      });
      resources.set(name, {
        name,
        uid: `uid-${binding.role}`,
        generation: '1',
        observedGeneration: '1',
        reconciling: false,
        conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
        serviceAccount: binding.runnerServiceAccount,
        containers: [
          {
            name: 'worker',
            image,
            env: Object.entries({
              TEMPORAL_BUILD_ID: buildId,
              TEMPORAL_TASK_QUEUES: `urm-${binding.role}`,
              TEMPORAL_DEPLOYMENT_NAME: binding.deploymentName,
              TEMPORAL_WORKER_HOSTING: 'cloud-run',
              TEMPORAL_DISPATCHER_ENABLED: 'false',
            }).map(([name, value]) => ({ name, value })),
          },
        ],
      });
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace,
        taskQueue: `urm-${binding.role}`,
        workflowsPath:
          binding.role === 'orchestration' ? require.resolve('../workflows/verification/runtime') : undefined,
        workerDeploymentOptions: {
          version: { deploymentName: binding.deploymentName, buildId },
          useWorkerVersioning: true,
          defaultVersioningBehavior: 'PINNED',
        },
        activities: createWorkerReadinessActivities({
          firestore: db,
          projectId: binding.projectId,
          buildId,
          queue: `urm-${binding.role}`,
          witness: {
            buildId,
            instanceId: `process-${binding.role}`,
            cloudRun: {
              projectId: binding.projectId,
              region: binding.region,
              pool: binding.poolName,
              revision,
              revisionUid: `uid-${binding.role}`,
              imageDigest: `sha256:${'b'.repeat(64)}`,
              serviceAccount: binding.runnerServiceAccount,
              instanceId: `native-${binding.role}`,
            },
          },
        }),
      });
      workers.push(worker);
      running.push(worker.run());
      const service = environment.connection.workflowService;
      let described: Awaited<ReturnType<typeof service.describeWorkerDeployment>> | undefined;
      for (let n = 0; n < 100; n++) {
        try {
          described = await service.describeWorkerDeployment({ namespace, deploymentName: binding.deploymentName });
          break;
        } catch (error) {
          if ((error as { code?: number }).code !== 5) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!described) throw new Error('Native worker registration failed');
      await service.setWorkerDeploymentCurrentVersion({
        namespace,
        deploymentName: binding.deploymentName,
        buildId,
        conflictToken: described.conflictToken,
        identity: 'local-readiness-collector-test',
      });
    }
    await expect(
      collectServerlessRoleReadiness({
        client,
        firestore: db,
        bindings,
        artifactDirectory: directory,
        onStartIntent: async () => {
          throw new Error('Native entry must reject local transport before intent');
        },
      })
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
    let persistedIntentId: string | undefined;
    proof = await collectServerlessReadinessObservations({
      client,
      firestore: db,
      bindings,
      artifactDirectory: directory,
      readResource: async (name) => resources.get(name),
      onStartIntent: async (intent) => {
        // Real SDK read proves persistence runs before the execution exists.
        await expect(client.workflow.getHandle(intent.workflowId).describe()).rejects.toBeInstanceOf(
          WorkflowNotFoundError
        );
        persistedIntentId = intent.workflowId;
      },
    });
    expect(persistedIntentId).toBe(proof.workflowId);
    expect(proof.roles.map((r) => r.role)).toEqual(['orchestration', 'controls', 'email']);
    expect(proof.roles[0].poolGeneration).toBe('9007199254740993');
    for (const role of proof.roles) {
      const snapshot = await db.collection(WORKER_READINESS_COLLECTION).doc(role.receipt.id).get();
      const { digest, ...data } = snapshot.data()!;
      expect(workerReadinessDigest(data)).toBe(digest); // Reordered native Firestore maps must verify.
      expect(data.runId).toBe(proof.runId);
    }
    expect(JSON.parse(await readFile(join(directory, 'readiness-proof.json'), 'utf8')).workflowId).toBe(
      proof.workflowId
    );
    await expect(
      collectServerlessReadinessObservations({
        client,
        firestore: db,
        bindings,
        artifactDirectory: directory,
        readResource: async (name) => resources.get(name),
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });
    const starts = jest.spyOn(client.workflow, 'start');
    const priorArtifacts = await readdir(directory);
    for (const savedIntent of [undefined, null]) {
      await expect(
        Reflect.apply(reconcileServerlessRoleReadiness, undefined, [
          {
            client,
            firestore: db,
            bindings,
            artifactDirectory: directory,
            savedIntent,
            onStartIntent: () => {
              throw new Error('Must not call a start callback');
            },
          },
        ])
      ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
      await expect(
        Reflect.apply(collectServerlessReadinessObservations, undefined, [
          {
            client,
            firestore: db,
            bindings,
            artifactDirectory: directory,
            savedIntent,
            readResource: async (name: string) => resources.get(name),
          },
        ])
      ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
    }
    await expect(
      Reflect.apply(reconcileServerlessRoleReadiness, undefined, [
        {
          client,
          firestore: db,
          bindings,
          artifactDirectory: directory,
        },
      ])
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
    expect(starts).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(priorArtifacts);
    const originalIntent = await readFile(join(directory, 'readiness-start-intent.json'), 'utf8');
    const originalAck = await readFile(join(directory, 'readiness-start-ack.json'), 'utf8');
    const originalProof = await readFile(join(directory, 'readiness-proof.json'), 'utf8');
    const savedIntent = JSON.parse(originalIntent);
    const reconciled = await collectServerlessReadinessObservations({
      client,
      firestore: db,
      bindings,
      artifactDirectory: directory,
      savedIntent,
      readResource: async (name) => resources.get(name),
      onStartIntent: async () => {
        throw new Error('Reconciliation must never start or persist a new intent');
      },
    });
    expect(reconciled.workflowId).toBe(proof.workflowId);
    expect(reconciled.runId).toBe(proof.runId);
    expect(reconciled.roles.map((role) => role.receipt)).toEqual(proof.roles.map((role) => role.receipt));
    expect(await readFile(join(directory, 'readiness-start-intent.json'), 'utf8')).toBe(originalIntent);
    expect(await readFile(join(directory, 'readiness-start-ack.json'), 'utf8')).toBe(originalAck);
    expect(await readFile(join(directory, 'readiness-proof.json'), 'utf8')).toBe(originalProof);
    await rename(join(directory, 'readiness-start-ack.json'), join(directory, 'retained-original-ack.json'));
    const withoutAck = await collectServerlessReadinessObservations({
      client,
      firestore: db,
      bindings,
      artifactDirectory: directory,
      savedIntent,
      readResource: async (name) => resources.get(name),
    });
    expect(withoutAck.runId).toBe(proof.runId);
    expect(starts).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'retained-original-ack.json'), 'utf8')).toBe(originalAck);
    const missingDirectory = await realpath(await mkdtemp(join(tmpdir(), 'urm-collector-not-started-')));
    try {
      const nonce = randomUUID().replaceAll('-', '');
      const neverStarted = { ...savedIntent, nonce, workflowId: `serverless-readiness-${nonce}` };
      await writeFile(join(missingDirectory, 'readiness-start-intent.json'), JSON.stringify(neverStarted), {
        mode: 0o600,
        flag: 'wx',
      });
      await expect(
        collectServerlessReadinessObservations({
          client,
          firestore: db,
          bindings,
          artifactDirectory: missingDirectory,
          savedIntent: neverStarted,
          readResource: async (name) => resources.get(name),
        })
      ).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      expect(starts).not.toHaveBeenCalled();
      await expect(client.workflow.getHandle(neverStarted.workflowId).describe()).rejects.toBeInstanceOf(
        WorkflowNotFoundError
      );
    } finally {
      await rm(missingDirectory, { recursive: true, force: true });
    }
    starts.mockRestore();

    await expect(
      collectServerlessReadinessObservations({
        client,
        firestore: db,
        bindings,
        artifactDirectory: directory,
        savedIntent: { ...savedIntent, nonce: '0'.repeat(32) },
        readResource: async (name) => resources.get(name),
      })
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
  } finally {
    for (const worker of workers) if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
    await Promise.allSettled(running);
    await environment.teardown();
    if (proof)
      for (const role of proof.roles) await db.collection(WORKER_READINESS_COLLECTION).doc(role.receipt.id).delete();
    await db.terminate();
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
