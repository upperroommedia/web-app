import { mediaJobParentFailureLine, mediaJobPhase } from './runtime/media-job-launch-failure';

/** Fixed image entrypoint. Supervision is capability-bound to a canonical media
 * start; ordinary workers keep their original in-process entrypoint. */
export async function launchApplicationWorker() {
  const { isMediaRecoveryConfiguration } = await mediaJobPhase(
    'dependencies',
    () => import('./runtime/media-recovery-config')
  );
  if (isMediaRecoveryConfiguration()) return launchMediaRecoveryApplication();
  if (
    process.env.FIREBASE_PROJECT_ID === 'urm-app-staging' &&
    process.env.TEMPORAL_WORKER_HOSTING === 'cloud-run' &&
    process.env.TEMPORAL_TASK_QUEUES === 'urm-media'
  ) {
    const { loadRuntimeConfig } = await import('./runtime/config');
    const config = loadRuntimeConfig();
    await import('@upperroom/shared/firebase/firebaseAdmin');
    const { getSharedFirebaseAppOwnership } = await import('@upperroom/shared/firebase/firebaseAdminOwnership');
    const ownership = getSharedFirebaseAppOwnership();
    if (!ownership) throw new Error('MEDIA_KERNEL_FIREBASE_OWNER_REQUIRED');
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const db = getFirestore(ownership.app);
      const { loadWorkerWitness } = await import('./runtime/worker-witness');
      const parent = await loadWorkerWitness(config.buildId, true);
      const { mediaKernelContext, superviseMediaKernel } = await import('./runtime/media-kernel-supervisor');
      const { restoredMediaKernelContext } = await import('./runtime/restored-media-startup');
      const { getAuth } = await import('firebase-admin/auth');
      const restored = await restoredMediaKernelContext(db, () => getAuth(ownership.app), parent);
      if (restored) {
        const { superviseRestoredMediaKernel } = await import('./runtime/media-kernel-supervisor');
        const result = await superviseRestoredMediaKernel(
          db,
          restored,
          require('node:path').resolve(__dirname, 'index.js')
        );
        if (result.code !== 0) process.exitCode = 1;
        return;
      }
      const cap = await mediaKernelContext(db, parent);
      if (cap) {
        const result = await superviseMediaKernel(db, cap, require('node:path').resolve(__dirname, 'index.js'));
        if (result.code !== 0) process.exitCode = 1;
        return;
      }
      const { startWorkerProcess } = await import('./index');
      // On return, retain cleanup responsibility for the exact creator-owned app
      // if the original entrypoint failed before acquiring or deleting it.
      await startWorkerProcess();
      return;
    } finally {
      if (ownership.isRegistered()) {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => ownership.terminateFirestore()),
          Promise.resolve().then(() => ownership.deleteApp()),
        ]);
        if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
      }
    }
  }
  const { startWorkerProcess } = await import('./index');
  await startWorkerProcess();
}
if (require.main === module)
  void launchApplicationWorker().catch((error) => {
    process.exitCode = 1;
    console.error(mediaJobParentFailureLine(error));
  });

/** Explicit private branch; no expired/missing capability falls back to normal. */
async function launchMediaRecoveryApplication() {
  const config = await mediaJobPhase('config', async () => {
    const { loadMediaRecoveryRuntimeConfig } = await import('./runtime/media-recovery-config');
    return loadMediaRecoveryRuntimeConfig();
  });
  const ownership = await mediaJobPhase('firebase-bootstrap', async () => {
    await import('@upperroom/shared/firebase/firebaseAdmin');
    const { getSharedFirebaseAppOwnership } = await import('@upperroom/shared/firebase/firebaseAdminOwnership');
    const owner = getSharedFirebaseAppOwnership();
    if (!owner || owner.app.options.projectId !== config.projectId || !owner.isRegistered())
      throw new Error('MEDIA_RECOVERY_FIREBASE_OWNER_REQUIRED');
    return owner;
  });
  let parentConnection: import('@temporalio/client').Connection | undefined;
  try {
    const { getFirestore } = await mediaJobPhase('dependencies', () => import('firebase-admin/firestore')),
      { getAuth } = await mediaJobPhase('dependencies', () => import('firebase-admin/auth'));
    const { loadWorkerWitness } = await mediaJobPhase('dependencies', () => import('./runtime/worker-witness'));
    const { mediaRecoveryKernelContext } = await mediaJobPhase(
      'dependencies',
      () => import('./runtime/media-recovery-capability')
    );
    const { superviseMediaRecoveryReplacementCycle } = await mediaJobPhase(
      'dependencies',
      () => import('./runtime/media-recovery-replacement')
    );
    const { Storage } = await mediaJobPhase('dependencies', () => import('@google-cloud/storage'));
    if (process.env.TEMPORAL_MEDIA_RECOVERY_CHILD !== undefined) throw new Error('MEDIA_RECOVERY_PARENT_REQUIRED');
    const parent = await mediaJobPhase('worker-witness', () =>
      loadWorkerWitness(config.buildId, true, process.env, async () => getFirestore(ownership.app)));
    const cap = await mediaJobPhase('capability', () =>
      mediaRecoveryKernelContext(getFirestore(ownership.app), getAuth(ownership.app), parent, config.operationId)
    );
    const { Client, Connection } = await mediaJobPhase('dependencies', () => import('@temporalio/client'));
    parentConnection = await mediaJobPhase('temporal-connect', () =>
      Connection.connect({
        address: config.address,
        tls: config.tls,
        apiKey: config.apiKey,
        interceptors: [],
        channelArgs: { 'grpc.enable_retries': 0 },
      })
    );
    const result = await mediaJobPhase('supervisor', () => {
      const parentClient = new Client({ connection: parentConnection, namespace: config.namespace });
      return superviseMediaRecoveryReplacementCycle(
        getFirestore(ownership.app),
        new Storage({ projectId: config.projectId, retryOptions: { autoRetry: false } }).bucket(
          'urm-app-staging.firebasestorage.app'
        ),
        cap,
        require('node:path').resolve(__dirname, 'index.js'),
        parentClient
      );
    });
    if (result.code !== 0) process.exitCode = 1;
  } finally {
    try {
      await parentConnection?.close();
    } catch {
      process.exitCode = 1;
    }
    if (ownership.isRegistered()) {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => ownership.terminateFirestore()),
        Promise.resolve().then(() => ownership.deleteApp()),
      ]);
      if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
    }
  }
}
