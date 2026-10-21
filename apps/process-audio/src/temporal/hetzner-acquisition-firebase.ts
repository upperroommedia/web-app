import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Database } from 'firebase-admin/database';
import type { Storage } from 'firebase-admin/storage';
import type { App } from 'firebase-admin/app';
interface HelperFirebase {
  app(): App;
  firestore(): Firestore;
  auth(): Auth;
  storage(): Storage;
  database(): Database;
}
const denied = () => new Error('YOUTUBE_HELPER_FIREBASE_CLEANUP_UNCONFIRMED');
async function boundedCleanup(run: () => Promise<unknown> | unknown): Promise<void> {
  const wall = Date.now(),
    mono = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(denied()), 5000);
      }),
    ]);
    if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw denied();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Isolated helper only. Teardown binds the creator's exact SDK/App handles,
 * including partial import failure; it never adopts an app by name or opens an
 * unused Firestore/RTDB service merely to clean it up. */
export async function withOwnedAcquisitionFirebase<T>(run: (services: HelperFirebase) => Promise<T>): Promise<T> {
  if (getSharedFirebaseAppOwnership()) throw denied();
  let owned: ReturnType<typeof getSharedFirebaseAppOwnership>;
  let db: Firestore | undefined,
    realtime: Database | undefined,
    failed = false;
  try {
    const { default: native } = await import('@upperroom/shared/firebase/firebaseAdmin');
    owned = getSharedFirebaseAppOwnership();
    if (!owned || !owned.isRegistered() || native.app() !== owned.app) throw denied();
    return await run({
      app: () => owned!.app,
      firestore: () => (db ??= native.firestore()),
      auth: () => native.auth(),
      storage: () => native.storage(),
      database: () => (realtime ??= native.database()),
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // The creator may have registered its app before module initialization threw.
    owned ??= getSharedFirebaseAppOwnership();
    let cleanupFailed = false;
    if (owned?.isRegistered()) {
      for (const cleanup of [
        ...(realtime ? [() => realtime!.goOffline()] : []),
        ...(db ? [() => owned!.terminateFirestore()] : []),
        () => owned!.deleteApp(),
      ]) {
        try {
          await boundedCleanup(cleanup);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed && !failed) throw denied();
  }
}
