/* eslint-disable no-console */
 
import {
  type Firestore,
  connectFirestoreEmulator,
  getFirestore,
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

  globalThis.__URM_FIRESTORE__ = getFirestore(firebase);

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
