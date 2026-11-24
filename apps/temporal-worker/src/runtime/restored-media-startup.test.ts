import { randomUUID } from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { releaseProvenanceDigest } from './media-recovery-history';
import { RESTORED_MEDIA_BOOT_V2_POLICY } from './restored-media-boot-window';
import { recordRestoredMediaStartupCapacity, restoredMediaKernelContext } from './restored-media-startup';
import { workerReadinessDigest } from './readiness-probe';
import { MEDIA_ALLOCATION_BYTES, MEDIA_ALLOCATION_PROGRAM_SHA256 } from './media-capacity-allocation';
import { mediaStartupBudget } from './media-startup-capacity';
import { verifyRestoredMediaBootPool } from './cloud-run-witness';
import type { WorkerWitness } from './worker-witness';

jest.mock('./cloud-run-witness', () => ({
  ...jest.requireActual('./cloud-run-witness'),
  verifyRestoredMediaBootPool: jest.fn(),
}));

const verifyPool = jest.mocked(verifyRestoredMediaBootPool);
const gate = '_control/temporalReleaseOperation';
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];

function fixture(version: 'v1' | 'v2' = 'v2', receiptLate = false) {
  const now = Date.now();
  const attemptedAt = new Date(now - 121000).toISOString();
  const birth = Timestamp.fromMillis(now - 1000);
  const opened = Timestamp.fromMillis(now - 180000);
  const operationId = randomUUID();
  const recoveryOperationId = randomUUID();
  const releaseId = randomUUID();
  const buildId = 'a'.repeat(40);
  const evidenceDigest = 'b'.repeat(64);
  const imageDigest = 'sha256:' + 'c'.repeat(64);
  const image = 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@' + imageDigest;
  const email = 'operator@example.com';
  const pool = 'urm-worker-media-' + buildId.slice(0, 20);
  const revision = pool + '.1';
  const name = 'projects/urm-app-staging/locations/us-central1/workerPools/' + pool;
  const before = {
    name,
    generation: '7',
    revision: name + '/revisions/' + revision,
    revisionUid: 'native-revision',
    uid: 'native-pool',
    etag: 'zero-version',
    desiredManualInstanceCount: 0,
  };
  const witness: WorkerWitness = {
    instanceId: randomUUID(),
    buildId,
    cloudRun: {
      projectId: 'urm-app-staging',
      region: 'us-central1',
      pool,
      revision,
      revisionUid: before.revisionUid,
      imageDigest,
      instanceId: 'cloud-instance',
      serviceAccount: 'tw-m-' + buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com',
    },
  };
  const completion = { identityState: { plan: { job: { name: 'original-finite-diagnostic' } } } };
  const capsuleInput = {
    schemaVersion: 2,
    kind: 'completed-media-recovery-job-provenance-v2',
    operationId: recoveryOperationId,
    releaseId,
    source: { buildId, image, evidenceDigest },
    completionSHA256: releaseProvenanceDigest(completion),
    restoredPool: before,
  };
  const capsuleSHA256 = releaseProvenanceDigest(capsuleInput);
  const bindingDigest = 'd'.repeat(64);
  const plan = {
    operationId,
    recoveryOperationId,
    releaseId,
    bindingDigest,
    buildId,
    image,
    evidenceDigest,
    role: 'media',
    schemaVersion: 1,
    receiptsSHA256: 'e'.repeat(64),
    createdAt: new Date(now - 140000).toISOString(),
    startup: {
      protocol: version === 'v2' ? RESTORED_MEDIA_BOOT_V2_POLICY.protocol : 'restored-normal-media-kernel-v1',
      capacity: 'filesystem-allocation-native-audio-and-kernel-v4',
      sourceBytes: 20 * 1024 ** 3,
      outputBytes: 20 * 1024 ** 3,
      workspaceBytes: 64 * 1024 ** 3,
      headroomBytes: 16 * 1024 ** 3,
      ...(version === 'v2' && { bootPolicy: RESTORED_MEDIA_BOOT_V2_POLICY }),
    },
    origin: {
      kind: 'restored-media-activation-origin-v1',
      operationId,
      recoveryOperationId,
      releaseId,
      bindingDigest,
      buildId,
      image,
      pool: before,
      capsuleSHA256,
      proofSHA256: 'f'.repeat(64),
    },
    receiptIds: {
      ...Object.fromEntries(
        'runner,scaler,pool,runnerScaler,scalerTrust,poolAccess,firestore,projectRole,projectAccess,storageRole,storageAccess,bootstrapCycle'
          .split(',')
          .map((id) => [id, randomUUID()])
      ),
      recovery: recoveryOperationId,
    },
  };
  const lock = {
    action: 'activate-restored-cloud-run-media',
    operationId,
    releaseId,
    bindingDigest,
    operatorPrincipal: { adcAndGcloudAccountMatch: true, email },
    cloudRestoredMediaActivation: {
      stage: 'starting',
      plan,
      start: {
        stage: 'acknowledged',
        attemptedAt,
        before,
        phaseSHA256: 'a'.repeat(64),
        computeSHA256: 'b'.repeat(64),
        quota: { evidence: true },
        nativeOperation: 'projects/urm-app-staging/locations/us-central1/operations/original-start',
        request: {
          url: 'https://run.googleapis.com/v2/' + name + '?updateMask=scaling',
          method: 'PATCH',
          body: { name, etag: before.etag, scaling: { manualInstanceCount: 1 } },
        },
      },
    },
  };
  const kernelPath = '_control/temporalRestoredMediaKernel-' + operationId;
  const values = new Map<string, object>([
    [gate, lock],
    [
      '_control/temporalRelease',
      {
        releaseId,
        admission: 'paused',
        domains: Object.fromEntries(domains.map((domain) => [domain, { admission: 'paused' }])),
      },
    ],
    ['_control/temporalReleaseState', { releaseId, phase: 'provider-usage-ready' }],
    ['_control/temporalMediaRecoveryCapsule-' + recoveryOperationId, { ...capsuleInput, capsuleSHA256 }],
    ['_control/temporalCloudMediaRecovery-' + recoveryOperationId, completion],
  ]);
  const startupPath = 'temporalRestoredMediaStartupCapacity/' + operationId;
  const snapshot = (path: string) => {
    const data = structuredClone(values.get(path));
    const observedAt = (data as { observedAt?: string })?.observedAt;
    const time =
      path === kernelPath
        ? birth
        : path === startupPath && observedAt
        ? Timestamp.fromMillis(receiptLate ? birth.toMillis() + 120000 : Date.parse(observedAt) + 1)
        : opened;
    const updateTime =
      path === kernelPath && (data as { stage?: string })?.stage === 'running'
        ? Timestamp.fromMillis(birth.toMillis() + 200)
        : time;
    return {
      exists: data !== undefined,
      createTime: time,
      updateTime,
      data: () => data,
      get: (field: string) => field.split('.').reduce<any>((value, key) => value?.[key], data),
    };
  };
  const tx = {
    get: async ({ path }: { path: string }) => snapshot(path),
    create: ({ path }: { path: string }, data: object) => {
      expect(values.has(path)).toBe(false);
      values.set(path, data);
    },
  };
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path: string) => ({ path, get: async () => snapshot(path) }),
    collection: (path: string) => ({ doc: (id: string) => ({ path: path + '/' + id }) }),
    runTransaction: (read: (t: typeof tx) => unknown) => read(tx),
  } as unknown as Firestore;
  const auth = () =>
    ({
      getUserByEmail: async () => ({ uid: 'original-admin', email, disabled: false, customClaims: { role: 'admin' } }),
    } as unknown as Auth);
  return { db, auth, witness, lock, values, kernelPath, startupPath, birth, before };
}

beforeEach(() => {
  verifyPool.mockReset();
  verifyPool.mockResolvedValue(undefined);
});

test('v2 binds only its newly created original arm after a cold start outside the v1 window', async () => {
  const f = fixture();
  const context = await restoredMediaKernelContext(f.db, f.auth, f.witness);
  const arm = {
    schemaVersion: 1,
    stage: 'armed',
    context: context?.context,
    intent: {
      parentPid: process.pid,
      launchId: randomUUID(),
      createdAt: new Date(f.birth.toMillis() - 100).toISOString(),
    },
  };
  f.values.set(f.kernelPath, arm);
  await context?.bindArm?.(arm);
  expect(context?.enrollmentWindow?.().armAt).toBe(f.birth.toMillis());
  expect(verifyPool).toHaveBeenCalledTimes(2);
  expect(verifyPool).toHaveBeenLastCalledWith(f.witness.cloudRun, f.before);
  await expect(context?.bindArm?.(arm)).rejects.toThrow('RESTORED_MEDIA_STARTUP_UNCONFIRMED');
  await expect(restoredMediaKernelContext(f.db, f.auth, f.witness)).rejects.toThrow(
    'RESTORED_MEDIA_STARTUP_UNCONFIRMED'
  );
});

test('the original v1 window is still measured from the START attempt', async () => {
  const f = fixture('v1');
  await expect(restoredMediaKernelContext(f.db, f.auth, f.witness)).rejects.toThrow(
    'RESTORED_MEDIA_STARTUP_UNCONFIRMED'
  );
  expect(verifyPool).not.toHaveBeenCalled();
});

test('v2 rejects a same-root intent rewrite after the native pool observation', async () => {
  const f = fixture();
  verifyPool.mockImplementationOnce(async () => {
    f.lock.cloudRestoredMediaActivation.start.phaseSHA256 = '9'.repeat(64);
  });
  await expect(restoredMediaKernelContext(f.db, f.auth, f.witness)).rejects.toThrow(
    'RESTORED_MEDIA_STARTUP_UNCONFIRMED'
  );
});

test('v2 denies a child without a known original native START acknowledgement', async () => {
  const f = fixture();
  f.lock.cloudRestoredMediaActivation.start.stage = 'attempted';
  await expect(restoredMediaKernelContext(f.db, f.auth, f.witness, true)).rejects.toThrow(
    'RESTORED_MEDIA_STARTUP_UNCONFIRMED'
  );
  expect(verifyPool).not.toHaveBeenCalled();
});

test.each([false, true])('v2 capacity receipt with late native commit = %s', async (receiptLate) => {
  const f = fixture('v2', receiptLate);
  const parent = await restoredMediaKernelContext(f.db, f.auth, f.witness);
  if (!parent?.bindArm) throw new Error('The original parent was not enrolled');
  const armTime = f.birth.toMillis();
  const arm = {
    schemaVersion: 1,
    stage: 'armed',
    context: parent.context,
    intent: {
      parentPid: process.pid + 1,
      launchId: randomUUID(),
      createdAt: new Date(armTime - 100).toISOString(),
    },
  };
  f.values.set(f.kernelPath, arm);
  await parent.bindArm(arm);
  const witness = { ...f.witness, instanceId: randomUUID() };
  const child = {
    ...arm,
    stage: 'running',
    birth: { nonce: randomUUID(), pid: process.pid, spawnedAt: new Date(armTime + 100).toISOString() },
    worker: witness,
  };
  f.values.set(f.kernelPath, child);
  const kernel = {
    operationId: f.lock.operationId,
    birthDigest: workerReadinessDigest({
      context: child.context,
      intent: child.intent,
      birth: child.birth,
      worker: child.worker,
    }),
  };
  const sha = 'a'.repeat(64);
  const enrollment = recordRestoredMediaStartupCapacity({
    firestore: f.db,
    auth: f.auth,
    buildId: witness.buildId,
    witness,
    kernel,
    canary: async (_draining, _processing, _allocation, assertAuthority) => {
      await assertAuthority?.();
      return {
        schemaVersion: 3,
        budgets: mediaStartupBudget,
        totalBytes: 100 * 1024 ** 3,
        availableBytes: 90 * 1024 ** 3,
        canaryBytes: 1024 ** 2,
        writeReadFsync: true,
        cleanupConfirmed: true,
        reservationReleased: true,
        observedAt: new Date(armTime + 400).toISOString(),
        allocation: {
          schemaVersion: 1,
          requestedBytes: MEDIA_ALLOCATION_BYTES,
          allocatedBytes: MEDIA_ALLOCATION_BYTES,
          programSHA256: MEDIA_ALLOCATION_PROGRAM_SHA256,
          pythonSHA256: sha,
          fileInode: 10,
          filesystemDevice: 20,
          minimumAvailableBytesWhileHeld: 16 * 1024 ** 3,
          availableBytesAfterAllocation: 16 * 1024 ** 3,
          startedAt: new Date(armTime + 300).toISOString(),
          releasedAt: new Date(armTime + 350).toISOString(),
          cleanupConfirmed: true,
        },
        processing: {
          schemaVersion: 1,
          ffmpegSHA256: sha,
          ffprobeSHA256: sha,
          sourceBytes: 32044,
          outputBytes: 32044,
          channels: 1,
          sampleRate: 16000,
          durationSeconds: 1,
          pcmSamplesVerified: 16000,
          progressBeforeCancellation: true,
          cancelledChildDrained: true,
          retryCompleted: true,
        },
      };
    },
  });
  if (receiptLate) {
    await expect(enrollment).rejects.toThrow('RESTORED_MEDIA_STARTUP_UNCONFIRMED');
  } else {
    const polling = await enrollment;
    if (!polling) throw new Error('The original child did not receive polling authority');
    await expect(polling.authorizePolling()).resolves.toBeUndefined();
    f.values.set(f.kernelPath, { ...child, worker: { ...witness, instanceId: randomUUID() } });
    await expect(polling.authorizePolling()).rejects.toThrow();
  }
  expect(f.values.get(f.startupPath)).toMatchObject({
    kind: 'restored-normal-media-startup-capacity-v2',
    kernel,
    worker: witness,
  });
});
