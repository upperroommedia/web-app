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
// Fail if staging even loads the live transport adapter.
jest.mock('@upperroom/function-kit-firestore-send-email/lib/temporal/provider', () => {
  throw new Error('STAGING_LOADED_LIVE_EMAIL_PROVIDER');
});
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
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, realpath, rename, readdir, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { cloudRunPollerIdentity } from '../runtime/cloud-run-witness';
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
  verifyStagingEmailReceipt,
  type ServerlessRoleBinding,
} from '../runtime/serverless-release-readiness';

test('staging collector binds only fresh capture evidence to the native execution', async () => {
  const { expectedEmailCaptureReadiness } = await import(
    '@upperroom/function-kit-firestore-send-email/lib/temporal/capture'
  );
  const nonce = 'a'.repeat(32),
    runId = randomUUID();
  const observedAt = new Date().toISOString(),
    startedAt = Date.parse(observedAt);
  const valid = { ...expectedEmailCaptureReadiness(nonce, runId), observedAt };
  const check = (value: unknown) => verifyStagingEmailReceipt(value, nonce, runId, startedAt, observedAt);
  await expect(check(valid)).resolves.toBeUndefined();
  for (const invalid of [
    {
      provider: 'smtp',
      authenticationVerified: true,
      tlsVerified: true,
      mailPermissionVerified: false,
      noMessageSent: true,
      observedAt,
    },
    { ...valid, provider: 'sendgrid' },
    { ...valid, tlsVerified: true },
    { ...valid, externalDelivery: 'false' },
    { ...valid, profileId: 'another-profile' },
    { ...valid, captureId: '0'.repeat(64) },
    { ...valid, payloadSha256: '0'.repeat(64) },
    { ...expectedEmailCaptureReadiness(nonce, randomUUID()), observedAt },
    { ...valid, observedAt: new Date(startedAt - 6000).toISOString() },
    { ...valid, observedAt: new Date(startedAt + 1).toISOString() },
    { ...valid, observedAt: [observedAt] },
  ])
    await expect(check(invalid)).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
});

test('collector joins actual version routing, native activity history and private Firestore receipts', async () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  if (
    !new RegExp(`^(127\\.0\\.0\\.1|localhost):${config.emulators.firestore.port}$`).test(
      process.env.FIRESTORE_EMULATOR_HOST ?? ''
    )
  )
    throw new Error('Dedicated emulator required');
  const app = initializeApp({ projectId: 'urm-app-staging' });
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
    runnerServiceAccount: `tw-${i === 0 ? 'o' : role === 'email' ? 'e' : 'c'}-${buildId.slice(
      0,
      20
    )}@urm-app-staging.iam.gserviceaccount.com`,
  }));
  // Official-schema fixtures isolate Cloud Run GETs only. They are NOT real cloud attestations.
  const resources = new Map<string, unknown>();
  let proof: Awaited<ReturnType<typeof collectServerlessReadinessObservations>> | undefined;
  let lostAckReceiptIds: string[] = [];
  const previousMode = process.env.STAGING_PROVIDER_MODE;
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
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
      const processId = randomUUID();
      const instanceId = `native-${binding.role}`;
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace,
        taskQueue: `urm-${binding.role}`,
        identity: cloudRunPollerIdentity(instanceId, processId),
        workflowsPath:
          binding.role === 'orchestration' ? require.resolve('../workflows/verification/runtime') : undefined,
        workerDeploymentOptions: {
          version: { deploymentName: binding.deploymentName, buildId },
          useWorkerVersioning: true,
          defaultVersioningBehavior: 'PINNED',
        },
        activities: createWorkerReadinessActivities({
          workflowBundle: { schemaVersion: 1, buildId, bundleSHA256: 'f'.repeat(64), bundleBytes: 100 },
          firestore: db,
          projectId: binding.projectId,
          buildId,
          queue: `urm-${binding.role}`,
          witness: {
            buildId,
            instanceId: processId,
            cloudRun: {
              projectId: binding.projectId,
              region: binding.region,
              pool: binding.poolName,
              revision,
              revisionUid: `uid-${binding.role}`,
              imageDigest: `sha256:${'b'.repeat(64)}`,
              serviceAccount: binding.runnerServiceAccount,
              instanceId,
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
        imageWorkflowBundleSHA256: 'f'.repeat(64),
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
      imageWorkflowBundleSHA256: 'f'.repeat(64),
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
      const binding = bindings.find((item) => item.role === role.role)!;
      const parent = `projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.poolName}`;
      expect(role.poolDigest).toBe(workerReadinessDigest(resources.get(parent)));
      expect(role.revisionDigest).toBe(workerReadinessDigest(resources.get(`${parent}/revisions/${role.revision}`)));
    }
    expect(proof.roles.map((r) => r.cloudStorage)).toEqual([
      {
        bucket: 'urm-app-staging.firebasestorage.app',
        permissions: ['storage.objects.create', 'storage.objects.delete', 'storage.objects.get'],
        observedAt: expect.any(String),
      },
      {
        bucket: 'urm-app-staging.firebasestorage.app',
        permissions: ['storage.objects.get'],
        observedAt: expect.any(String),
      },
      null,
    ]);
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
        imageWorkflowBundleSHA256: 'f'.repeat(64),
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
            imageWorkflowBundleSHA256: 'f'.repeat(64),
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
            imageWorkflowBundleSHA256: 'f'.repeat(64),
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
          imageWorkflowBundleSHA256: 'f'.repeat(64),
        },
      ])
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
    expect(starts).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(priorArtifacts);
    const originalIntent = await readFile(join(directory, 'readiness-start-intent.json'), 'utf8');
    const originalAck = await readFile(join(directory, 'readiness-start-ack.json'), 'utf8');
    const originalProof = await readFile(join(directory, 'readiness-proof.json'), 'utf8');
    const savedIntent = JSON.parse(originalIntent);
    // The private native receipt and original expected-image intent must agree.
    const orchestration = proof.roles.find((role) => role.role === 'orchestration')!;
    const receiptRef = db.collection(WORKER_READINESS_COLLECTION).doc(orchestration.receipt.id);
    const receipt = (await receiptRef.get()).data()!;
    for (const patch of [
      { schemaVersion: 1 },
      { workflowBundle: null },
      { workflowBundle: { ...receipt.workflowBundle, bundleSHA256: '0'.repeat(64) } },
    ]) {
      await receiptRef.set({ ...receipt, ...patch });
      await expect(
        collectServerlessReadinessObservations({
          client,
          firestore: db,
          bindings,
          artifactDirectory: directory,
          imageWorkflowBundleSHA256: 'f'.repeat(64),
          savedIntent,
          readResource: async (name) => resources.get(name),
        })
      ).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      expect(starts).not.toHaveBeenCalled();
    }
    await receiptRef.set(receipt);

    // Keep the original native run, activity receipt and start history. A mismatched
    // completion identity in the collector's transport cannot authorize readiness.
    const actualGetHandle = client.workflow.getHandle.bind(client.workflow);
    const handles = jest.spyOn(client.workflow, 'getHandle').mockImplementation((...args) => {
      const handle = actualGetHandle(...args);
      const actualHistory = handle.fetchHistory.bind(handle);
      handle.fetchHistory = async () => {
        const history = await actualHistory();
        const completion = history.events?.find(
          (event) => event.activityTaskCompletedEventAttributes
        )?.activityTaskCompletedEventAttributes;
        if (completion) completion.identity = 'another-process';
        return history;
      };
      return handle;
    });
    try {
      await expect(
        collectServerlessReadinessObservations({
          client,
          firestore: db,
          bindings,
          artifactDirectory: directory,
          imageWorkflowBundleSHA256: 'f'.repeat(64),
          savedIntent,
          readResource: async (name) => resources.get(name),
        })
      ).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      expect(starts).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual(priorArtifacts);
    } finally {
      handles.mockRestore();
    }

    await expect(
      collectServerlessReadinessObservations({
        client,
        firestore: db,
        bindings,
        artifactDirectory: directory,
        imageWorkflowBundleSHA256: '0'.repeat(64),
        savedIntent,
        readResource: async (name) => resources.get(name),
      })
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
    expect(starts).not.toHaveBeenCalled();
    // Additional release artifacts must follow successful collector validation.
    // A corrupt persisted directory must never gain even a policy-only receipt.
    for (const invalid of ['symlink', 'nonprivate', 'mismatched-intent']) {
      const caseRoot = await realpath(await mkdtemp(join(tmpdir(), 'cloud-policy-artifact-denial-')));
      const invalidDirectory = join(caseRoot, 'saved');
      try {
        if (invalid === 'symlink') await symlink(directory, invalidDirectory);
        else {
          await mkdir(invalidDirectory, { mode: invalid === 'nonprivate' ? 0o755 : 0o700 });
          if (invalid === 'nonprivate') await chmod(invalidDirectory, 0o755);
          await writeFile(
            join(invalidDirectory, 'readiness-start-intent.json'),
            JSON.stringify(invalid === 'mismatched-intent' ? { ...savedIntent, nonce: randomUUID() } : savedIntent),
            { flag: 'wx', mode: 0o600 }
          );
        }
        const retained = await readdir(invalidDirectory);
        await expect(
          collectServerlessReadinessObservations({
            client,
            firestore: db,
            bindings,
            artifactDirectory: invalidDirectory,
            imageWorkflowBundleSHA256: 'f'.repeat(64),
            savedIntent,
            readResource: async (name) => resources.get(name),
          }).then(async () => {
            await writeFile(join(invalidDirectory, 'scaler-policy-must-not-exist.json'), '{}', {
              flag: 'wx',
              mode: 0o600,
            });
          })
        ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
        expect(await readdir(invalidDirectory)).toEqual(retained);
      } finally {
        await rm(caseRoot, { recursive: true, force: true });
      }
    }
    expect(starts).not.toHaveBeenCalled();
    const reconciled = await collectServerlessReadinessObservations({
      client,
      firestore: db,
      bindings,
      artifactDirectory: directory,
      imageWorkflowBundleSHA256: 'f'.repeat(64),
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
      imageWorkflowBundleSHA256: 'f'.repeat(64),
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
          imageWorkflowBundleSHA256: 'f'.repeat(64),
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

    // The original native START commits, but the caller loses its response
    // before writing a local ACK. Reconcile that exact run without a new START.
    const lostAckDirectory = await realpath(await mkdtemp(join(tmpdir(), 'urm-collector-lost-ack-')));
    const autoStart = client.workflow.start.bind(client.workflow);
    const sent = jest.spyOn(client.workflow, 'start').mockImplementationOnce(async (...args) => {
      await autoStart(...args);
      throw new Error('Controlled loss of the native START acknowledgement');
    });
    try {
      const common = {
        client,
        firestore: db,
        bindings,
        artifactDirectory: lostAckDirectory,
        imageWorkflowBundleSHA256: 'f'.repeat(64),
        readResource: async (name: string) => resources.get(name),
      };
      await expect(collectServerlessReadinessObservations(common)).rejects.toThrow(
        'SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT'
      );
      const saved = JSON.parse(await readFile(join(lostAckDirectory, 'readiness-start-intent.json'), 'utf8'));
      const originalRun = await client.workflow.getHandle(saved.workflowId).describe();
      lostAckReceiptIds = bindings.map(({ role }) =>
        createHash('sha256').update(`${originalRun.runId}:${role}:${saved.nonce}`).digest('hex')
      );
      expect(await readdir(lostAckDirectory)).toEqual(['readiness-start-intent.json']);
      const recovery = await collectServerlessReadinessObservations({ ...common, savedIntent: saved });
      expect(recovery.workflowId).toBe(saved.workflowId);
      expect(recovery.runId).toBe(originalRun.runId);
      expect(recovery.roles.map((role) => role.receipt.id)).toEqual(lostAckReceiptIds);
      // Leave the native history and digest-bound summary intact. Only the
      // underlying capture changes, so these failures require an independent read.
      const email = recovery.roles.find((role) => role.role === 'email')!.email;
      const ref = db.collection('_mailSandboxCaptures').doc(email.captureId);
      const record = (await ref.get()).data()!;
      const checkCapture = () => collectServerlessReadinessObservations({ ...common, savedIntent: saved });
      await ref.update({ externalDelivery: true });
      await expect(checkCapture()).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      await ref.delete();
      await expect(checkCapture()).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      // Exact payload and equal create/update times, but recreated after native completion.
      await ref.create(record);
      await expect(checkCapture()).rejects.toThrow('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      sent.mockRestore();
      await rm(lostAckDirectory, { recursive: true, force: true });
    }

    await expect(
      collectServerlessReadinessObservations({
        client,
        firestore: db,
        bindings,
        artifactDirectory: directory,
        imageWorkflowBundleSHA256: 'f'.repeat(64),
        savedIntent: { ...savedIntent, nonce: '0'.repeat(32) },
        readResource: async (name) => resources.get(name),
      })
    ).rejects.toThrow('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
  } finally {
    for (const worker of workers) if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
    await Promise.allSettled(running);
    await environment.teardown();
    for (const id of [...(proof?.roles.map((role) => role.receipt.id) ?? []), ...lostAckReceiptIds]) {
      const receipt = db.collection(WORKER_READINESS_COLLECTION).doc(id);
      const captureId = (await receipt.get()).get('email.captureId');
      if (captureId) await db.collection('_mailSandboxCaptures').doc(captureId).delete();
      await receipt.delete();
    }
    if (previousMode === undefined) delete process.env.STAGING_PROVIDER_MODE;
    else process.env.STAGING_PROVIDER_MODE = previousMode;
    await db.terminate();
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
