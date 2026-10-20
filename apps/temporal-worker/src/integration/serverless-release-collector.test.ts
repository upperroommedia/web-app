import { msToTs } from '@temporalio/common/lib/time';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
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
  const bindings: ServerlessRoleBinding[] = ['orchestration', 'controls'].map((role, i) => ({
    projectId: 'urm-app-staging',
    region: 'us-central1',
    namespace,
    role: role as 'orchestration' | 'controls',
    buildId,
    image,
    poolName: `urm-worker-${role}-${buildId.slice(0, 20)}`,
    deploymentName: i === 0 ? 'urm-worker-staging' : 'urm-worker-controls-staging',
    runnerServiceAccount: `tw-${i === 0 ? 'o' : 'c'}-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
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
    expect(proof.roles.map((r) => r.role)).toEqual(['orchestration', 'controls']);
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
