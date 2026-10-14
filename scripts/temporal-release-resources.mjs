/** Own one named Admin app; never initialize credentials or services during cleanup. */
export function createReleaseFirebaseResources(projectId, databaseURL, sdk) {
  const name = `temporal-release-${projectId}`;
  const existing = sdk.getApps().find((app) => app.name === name);
  const app = existing ?? sdk.initializeApp({ projectId, databaseURL, credential: sdk.applicationDefault() }, name);
  const owned = !existing;
  const validate = () => {
    if (
      app.name !== name ||
      app.options.projectId !== projectId ||
      app.options.databaseURL !== databaseURL ||
      sdk.getApps().find((candidate) => candidate.name === name) !== app
    )
      throw new Error('Release Firebase app identity changed; refusing shared-resource cleanup');
  };
  validate();
  let firestore,
    database,
    closed = false;
  return {
    credential: app.options.credential,
    get firestore() {
      return (firestore ??= sdk.getFirestore(app));
    },
    get database() {
      return databaseURL ? (database ??= sdk.getDatabase(app)) : undefined;
    },
    serverTimestamp: sdk.serverTimestamp,
    async close() {
      if (!owned || closed) return;
      validate();
      closed = true;
      const failures = [];
      for (const [step, cleanup] of [
        ['database-offline', () => database?.goOffline()],
        ['firestore-terminate', () => firestore?.terminate()],
        ['app-delete', () => sdk.deleteApp(app)],
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push({ step, error });
        }
      }
      if (failures.length) {
        const error = new Error(`Release SDK cleanup failed: ${failures.map((f) => f.step).join(', ')}`);
        error.code = 'RELEASE_SDK_CLEANUP_FAILED';
        Object.defineProperty(error, 'cleanupFailures', { value: failures });
        throw error;
      }
    },
  };
}

/** An action failure remains the primary failure even when a later finalizer fails. */
export async function runWithCleanup(work, cleanup, reportSecondary = (error) => console.error(error.message)) {
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (!failed) throw error;
      // Report only the safe cleanup summary; never replace the operation error.
      try {
        reportSecondary(error);
      } catch {
        /* Reporting must not replace the primary error. */
      }
    }
  }
}
