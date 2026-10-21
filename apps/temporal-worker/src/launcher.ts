/** Fixed image entrypoint. Supervision is capability-bound to a canonical media
 * start; ordinary workers keep their original in-process entrypoint. */
export async function launchApplicationWorker() {
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
  void launchApplicationWorker().catch(() => {
    process.exitCode = 1;
    console.error('Application worker launch failed.');
  });
