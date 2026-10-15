import {
  isDemoEmulatorMode,
  connectDemoFirebaseEmulator,
  assertDemoFirebaseApp,
} from '../../../packages/shared/firebase/demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
/* eslint-disable no-console */

import {
  type Firestore,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  type FirestoreSettings,
} from 'firebase/firestore';

declare global {
  var __URM_FIRESTORE__: Firestore | undefined;
  var __URM_FIRESTORE_EMULATOR_CONNECTED__: boolean | undefined;
}

const createBrowserFirestore = (): Firestore => {
  if (globalThis.__URM_FIRESTORE__) {
    if (isDemoEmulatorMode) assertDemoFirebaseApp(globalThis.__URM_FIRESTORE__.app.options);
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

if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('firestore', firestore, () =>
    connectFirestoreEmulator(firestore, '127.0.0.1', getFirebaseEmulatorPort('firestore'))
  );
} else if (isEmulatorMode && !globalThis.__URM_FIRESTORE_EMULATOR_CONNECTED__) {
  console.log('Connecting to Firestore emulator');
  globalThis.__URM_FIRESTORE_EMULATOR_CONNECTED__ = true;
  connectFirestoreEmulator(firestore, '127.0.0.1', getFirebaseEmulatorPort('firestore'));
}
export default firestore;
export * from 'firebase/firestore';
