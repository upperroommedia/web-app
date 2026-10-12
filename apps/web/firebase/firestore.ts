/* eslint-disable no-console */

import {
  type Firestore,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  type FirestoreSettings,
} from 'firebase/firestore';
import firebase, { isDevelopment } from './firebase';

declare global {
  var __URM_FIRESTORE__: Firestore | undefined;
  var __URM_FIRESTORE_EMULATOR_CONNECTED__: boolean | undefined;
}

const createBrowserFirestore = (): Firestore => {
  if (globalThis.__URM_FIRESTORE__) {
    return globalThis.__URM_FIRESTORE__;
  }

  // WebChannel fetch-stream cancellation can escape as an unhandled rejection.
  // Use its XHR transport in browsers; server-side Firestore keeps its default.
  // Firebase still consumes this option at runtime but omits it from public types.
  const browserSettings: FirestoreSettings & { useFetchStreams: boolean } = {
    useFetchStreams: false,
  };
  globalThis.__URM_FIRESTORE__ = initializeFirestore(firebase, browserSettings);

  return globalThis.__URM_FIRESTORE__;
};

const firestore = typeof window === 'undefined' ? getFirestore(firebase) : createBrowserFirestore();

if (isDevelopment && !globalThis.__URM_FIRESTORE_EMULATOR_CONNECTED__) {
  console.log('Connecting to Firestore emulator');
  globalThis.__URM_FIRESTORE_EMULATOR_CONNECTED__ = true;
  connectFirestoreEmulator(firestore, '127.0.0.1', 8081);
}
export default firestore;
export * from 'firebase/firestore';
