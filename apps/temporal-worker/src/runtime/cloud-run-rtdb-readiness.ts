import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import type { WorkerWitness } from './worker-witness';

const databaseURL = 'https://urm-app-staging-default-rtdb.firebaseio.com/';
const overrides = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GCE_METADATA_HOST',
  'GCE_METADATA_IP',
  'GCE_METADATA_ROOT',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
];
function fail(): never {
  throw new Error('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
}
export interface CloudRunRtdbReadiness {
  databaseURL: string;
  readPath: 'bundle-metadata';
  readSucceeded: true;
  observedAt: string;
}
/** Serving read with the worker's actual keyless ADC. A new SDK app excludes a
 * previously cached RTDB snapshot. No data is returned, persisted or logged.
 * Cloud Run is not required to expose a VM's configured metadata scope list:
 * actual native credential identity and the successful serving read are checked.
 */
export async function verifyCloudRunRtdbReadiness(witness: WorkerWitness): Promise<CloudRunRtdbReadiness> {
  let app: App | undefined, database: Database | undefined;
  let confirmed = false;
  const deadline = Date.now() + 18000;
  const bounded = async <T>(operation: () => Promise<T>, until: number): Promise<T> => {
    if (Date.now() >= until) fail();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED')), until - Date.now());
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const owned = getSharedFirebaseAppOwnership();
    const cloud = witness.cloudRun;
    if (
      overrides.some((name) => process.env[name] !== undefined) ||
      !cloud ||
      cloud.projectId !== 'urm-app-staging' ||
      cloud.region !== 'us-central1' ||
      !cloud.serviceAccount ||
      !owned ||
      !owned.isRegistered() ||
      owned.app.name !== '[DEFAULT]' ||
      owned.app.options.projectId !== cloud.projectId ||
      owned.app.options.databaseURL !== databaseURL
    )
      fail();
    const credential = owned.app.options.credential;
    if (!credential) fail();
    const compute = Reflect.get(credential, 'isComputeEngineCredential');
    const email = Reflect.get(credential, 'getServiceAccountEmail');
    if (
      typeof compute !== 'function' ||
      typeof email !== 'function' ||
      (await bounded(() => compute.call(credential), deadline)) !== true ||
      (await bounded(() => email.call(credential), deadline)) !== cloud.serviceAccount
    )
      fail();
    const name = `serverless-rtdb-${randomUUID()}`;
    const created = initializeApp({ projectId: cloud.projectId, databaseURL, credential }, name);
    if (created.name !== name) fail();
    app = created;
    database = getDatabase(app);
    await bounded(() => database!.ref('bundle-metadata').get(), deadline);
    confirmed = true;
  } catch {
    confirmed = false;
  } finally {
    if (database) {
      try {
        database.goOffline();
      } catch {
        confirmed = false;
      }
    }
    if (app) {
      try {
        await bounded(() => deleteApp(app!), Date.now() + 2000);
      } catch {
        confirmed = false;
      }
    }
  }
  if (!confirmed) fail();
  return { databaseURL, readPath: 'bundle-metadata', readSucceeded: true, observedAt: new Date().toISOString() };
}
