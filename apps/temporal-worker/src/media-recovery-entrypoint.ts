import { observedTaskAttestation } from './runtime/media-recovery-task-attestation-reader';
import { loadMediaRecoveryRuntimeConfig } from './runtime/media-recovery-config';
import { mediaRecoveryBucketName } from './runtime/media-recovery-storage';
import { loadWorkerWitness } from './runtime/worker-witness';
import { loadConsumedMediaRecoveryBundle } from './runtime/consumed-workflow-bundle';
import { reportMediaKernelWitness } from './runtime/media-kernel-supervisor';
import {
  createMediaRecoveryRegistration,
  createMediaRecoveryReplacementRegistration,
} from './runtime/media-recovery-registration';
import { runMediaFilesystemCanary, validateMediaStartupCapacityEvidence } from './runtime/media-startup-capacity';
import { WorkerLifecycle } from './runtime/worker-lifecycle';
import { MediaRecoveryPollingWorker } from './runtime/media-recovery-polling-worker';
import { initializeWorkerObservability, flushWorkerObservability } from './runtime/observability';
import { workerReadinessDigest as hash } from './runtime/readiness-probe';
import { holdOriginalMediaCompletion } from './runtime/media-recovery-original-fault';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, type Runtime } from '@temporalio/worker';
import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import { VersioningBehavior } from '@temporalio/common';
/** Actual index.js private branch. No fallback, dispatcher, ordinary readiness or
 * normal media queue. Canonical release preflight remains fixed-deny separately. */
export async function runMediaRecoveryApplication(bindShutdown?: (shutdown: () => Promise<void>) => void) {
  const config = loadMediaRecoveryRuntimeConfig();
  if (!['original', 'replacement'].includes(process.env.TEMPORAL_MEDIA_RECOVERY_CHILD ?? ''))
    throw new Error('MEDIA_RECOVERY_ORIGINAL_CHILD_REQUIRED');
  let runtime: Runtime | undefined,
    native: NativeConnection | undefined,
    connection: Connection | undefined,
    ownership: any,
    expiry: ReturnType<typeof setTimeout> | undefined,
    monitor: ReturnType<typeof setInterval> | undefined,
    probe: Promise<void> | undefined;
  const lifecycle = new WorkerLifecycle({
    onDraining: () => {
      if (expiry) clearTimeout(expiry);
      if (monitor) clearInterval(monitor);
    },
    stopDispatcher: async () => {},
    resources: [
      {
        name: 'media-recovery.monitor',
        close: async () => {
          await probe;
        },
      },
      {
        name: 'firebase.firestore',
        close: async () => {
          if (ownership?.isRegistered()) await ownership.terminateFirestore();
        },
      },
      {
        name: 'firebase.app',
        close: async () => {
          if (ownership?.isRegistered()) await ownership.deleteApp();
        },
      },
      {
        name: 'temporal.client',
        close: async () => {
          await connection?.close();
        },
      },
      {
        name: 'temporal.native',
        close: async () => {
          await native?.close();
        },
      },
      { name: 'observability', close: flushWorkerObservability },
      {
        name: 'temporal.runtime',
        close: async () => {
          await runtime?.shutdown();
        },
      },
    ],
  });
  const stop = () => {
    void lifecycle.shutdown().catch(() => undefined);
  };
  try {
    bindShutdown?.(() => lifecycle.shutdown());
    const existing = getSharedFirebaseAppOwnership();
    if (existing) {
      if (
        existing.app.name !== '[DEFAULT]' ||
        existing.app.options.projectId !== config.projectId ||
        !existing.isRegistered()
      )
        throw new Error('MEDIA_RECOVERY_FIREBASE_OWNER_REQUIRED');
      ownership = existing;
    }
    initializeWorkerObservability(config.projectId, config.buildId, config.queues, (x) => {
      runtime = x;
    });
    const bundle = await loadConsumedMediaRecoveryBundle(config.workflowBundle, config.buildId);
    if (lifecycle.draining) return;
    native = await NativeConnection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
    if (lifecycle.draining) return;
    connection = await Connection.connect({
      address: config.address,
      tls: config.tls,
      apiKey: config.apiKey,
      interceptors: [],
      channelArgs: { 'grpc.enable_retries': 0 },
    });
    if (lifecycle.draining) return;
    const client = new Client({ connection, namespace: config.namespace });
    const ns = await connection.withDeadline(Date.now() + 5000, () =>
      client.workflowService.describeNamespace({ namespace: config.namespace })
    );
    if (ns.namespaceInfo?.name !== config.namespace) throw new Error('MEDIA_RECOVERY_NAMESPACE_UNCONFIRMED');
    const witness = await loadWorkerWitness(config.buildId, true, process.env, async () => {
      await import('@upperroom/shared/firebase/firebaseAdmin');
      const owner = getSharedFirebaseAppOwnership();
      if (
        !owner ||
        owner.app.name !== '[DEFAULT]' ||
        owner.app.options.projectId !== config.projectId ||
        !owner.isRegistered()
      )
        throw new Error('MEDIA_RECOVERY_FIREBASE_OWNER_REQUIRED');
      ownership = owner;
      const { getFirestore } = await import('firebase-admin/firestore');
      return getFirestore(owner.app);
    });
    if (Boolean(witness.cloudRun) === Boolean(witness.cloudRunJob))
      throw new Error('MEDIA_RECOVERY_CLOUD_WITNESS_REQUIRED');
    const kernel = await reportMediaKernelWitness(witness);
    if (!kernel || !process.send) throw new Error('MEDIA_RECOVERY_PARENT_REQUIRED');
    if (lifecycle.draining) return;
    await import('@upperroom/shared/firebase/firebaseAdmin');
    const candidate = getSharedFirebaseAppOwnership();
    if (
      !candidate ||
      candidate.app.name !== '[DEFAULT]' ||
      candidate.app.options.projectId !== config.projectId ||
      !candidate.isRegistered()
    )
      throw new Error('MEDIA_RECOVERY_FIREBASE_OWNER_REQUIRED');
    ownership = candidate;
    const { getFirestore } = await import('firebase-admin/firestore'),
      { getAuth } = await import('firebase-admin/auth'),
      { Storage } = await import('@google-cloud/storage');
    const { getFirebaseStorageBucket } = await import('@upperroom/shared/shared/firebaseProjectConfig');
    if (getFirebaseStorageBucket() !== 'urm-app-staging.firebasestorage.app')
      throw new Error('MEDIA_RECOVERY_BUCKET_UNCONFIRMED');
    const { createRuntimeActivities } = await import('./runtime/activities');
    const db = getFirestore(ownership.app);
    const auth = getAuth(ownership.app);
    const replacement = process.env.TEMPORAL_MEDIA_RECOVERY_CHILD === 'replacement';
    const registration = await (replacement
      ? createMediaRecoveryReplacementRegistration
      : createMediaRecoveryRegistration)({
      firestore: db,
      auth,
      client,
      witness,
      operationId: config.operationId,
      kernel,
      createAcquisition: (cap) => {
        const bucket = new Storage({ projectId: config.projectId, retryOptions: { autoRetry: false } }).bucket(
          mediaRecoveryBucketName(cap.plan, Boolean(witness.cloudRunJob))
        );
        const isolated = cap.plan.diagnosticStorage && {
          bucket,
          operationId: config.operationId,
          releaseId: cap.plan.releaseId,
        };
        const runtime = createRuntimeActivities(config.projectId, ['urm-media'], client, witness, isolated);
        const media = runtime.queues['urm-media'];
        if (!('acquireMedia' in media)) throw new Error('MEDIA_RECOVERY_MEDIA_FACTORY_REQUIRED');
        return { bucket, acquire: media.acquireMedia };
      },
    });
    const capacity = await runMediaFilesystemCanary(
      () => lifecycle.draining,
      undefined,
      undefined,
      registration.authorize
    );
    validateMediaStartupCapacityEvidence(capacity, registration.cap.plan.createdAt);
    await registration.authorize();
    if (lifecycle.draining) return;
    const taskAttestation = witness.cloudRunJob && observedTaskAttestation(witness.cloudRunJob);
    const record = {
      schemaVersion: 1,
      kind: 'private-diagnostic-startup-only-no-recovery-proof',
      ...(taskAttestation ? { taskAttestation } : {}),
      operationId: config.operationId,
      intentSHA256: registration.cap.context.intentSHA256,
      worker: witness,
      kernel,
      bundle: bundle.evidence,
      capacity,
      observedAt: new Date().toISOString(),
    };
    const ref = db.doc(
      `_control/temporalMediaRecovery${replacement ? 'ReplacementStartup' : 'Startup'}-${config.operationId}`
    );
    try {
      await db.runTransaction(
        async (tx) => {
          await registration.cap.authorize(tx);
          if ((await tx.get(ref)).exists) throw new Error('MEDIA_RECOVERY_STARTUP_EXISTS');
          tx.create(ref, record);
        },
        { maxAttempts: 1 }
      );
    } catch {
      if (hash((await ref.get()).data() ?? null) !== hash(record))
        throw new Error('MEDIA_RECOVERY_STARTUP_UNCONFIRMED');
    }
    await registration.authorize();
    if (lifecycle.draining) return;
    console.log(
      JSON.stringify({
        event: 'temporal_media_recovery_worker_started',
        workerIdentity: `media-recovery-${witness.instanceId}`,
        ...(witness.cloudRunJob
          ? {
              job: witness.cloudRunJob.job,
              executionUid: witness.cloudRunJob.executionUid,
              ...(witness.cloudRunJob.taskUid ? { taskUid: witness.cloudRunJob.taskUid } : {}),
              ...(witness.cloudRunJob.taskCreateTime
                ? {
                    task: witness.cloudRunJob.task,
                    taskCreateTime: witness.cloudRunJob.taskCreateTime,
                  }
                : {}),
            }
          : {
              pool: witness.cloudRun?.pool,
              revision: witness.cloudRun?.revision,
              revisionUid: witness.cloudRun?.revisionUid,
            }),
        buildId: config.buildId,
        taskQueue: config.queues[0],
        operationId: config.operationId,
        child: replacement ? 'replacement' : 'original',
        startupSHA256: hash(record),
      })
    );
    const worker = await MediaRecoveryPollingWorker.create({
      connection: native,
      namespace: config.namespace,
      taskQueue: config.queues[0],
      identity: `media-recovery-${witness.instanceId}`,
      workflowBundle: { code: bundle.code },
      activities: {
        ...registration.activities,
        acquireMedia: replacement
          ? registration.activities.acquireMedia
          : holdOriginalMediaCompletion({
              db,
              bucket: registration.bucket,
              client,
              cap: registration.cap,
              birth: registration.birth,
              acquire: registration.activities.acquireMedia,
            }),
      },
      workerDeploymentOptions: {
        useWorkerVersioning: true,
        defaultVersioningBehavior: VersioningBehavior.PINNED,
        version: { deploymentName: config.deploymentName, buildId: config.buildId },
      },
      maxConcurrentActivityTaskExecutions: 1,
      maxHeartbeatThrottleInterval: '1 second',
      defaultHeartbeatThrottleInterval: '1 second',
      shutdownGraceTime: 8000,
    });
    lifecycle.workers.push(worker);
    await registration.authorize();
    if (lifecycle.draining) return;
    worker.allowPolling(() => !lifecycle.draining && Date.now() < registration.cap.plan.expiresAt);
    expiry = setTimeout(stop, Math.max(0, registration.cap.plan.expiresAt - Date.now()));
    monitor = setInterval(() => {
      if (lifecycle.draining || probe) return;
      probe = registration
        .authorize()
        .catch(stop)
        .finally(() => {
          probe = undefined;
        });
    }, 2000);
    lifecycle.completeStartup();
    await lifecycle.run();
  } finally {
    lifecycle.completeStartup();
    await lifecycle.shutdown();
  }
}
