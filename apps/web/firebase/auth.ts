/* eslint-disable no-console */
 
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import firebase, { isDevelopment } from './firebase';

const isAlreadyInitializedError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'auth/already-initialized';

const initializeBrowserAuth = (): Auth => {
  try {
    return initializeAuth(firebase, {
      // Keep IndexedDB second so Firebase can migrate existing sessions into
      // localStorage without selecting the broken @firebase/auth 1.13.4 path.
      persistence: [browserLocalPersistence, indexedDBLocalPersistence],
      // Firebase's Node entrypoint exports an unsupported resolver sentinel.
      // Supplying it during SSR crashes Next's production build, while browser
      // popup and redirect sign-in require the real browser resolver.
      ...(typeof window !== 'undefined' ? { popupRedirectResolver: browserPopupRedirectResolver } : {}),
    });
  } catch (error) {
    // Next.js hot reload can re-evaluate this module while the Firebase app and
    // its explicitly configured Auth instance are still alive.
    if (isAlreadyInitializedError(error)) {
      return getAuth(firebase);
    }
    throw error;
  }
};

const auth = initializeBrowserAuth();
if (isDevelopment && process.env.AUTH_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Auth emulator');
  process.env.AUTH_EMULATOR_STARTED = 'true';
  connectAuthEmulator(auth, 'http://127.0.0.1:9099');
}

export default auth;
export * from 'firebase/auth';
