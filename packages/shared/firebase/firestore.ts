import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from './demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from './emulatorPorts';
/* eslint-disable no-console */

import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
const firestore = getFirestore(firebase);
if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('firestore', firestore, () =>
    connectFirestoreEmulator(firestore, '127.0.0.1', getFirebaseEmulatorPort('firestore'))
  );
} else if (isEmulatorMode && process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Firestore emulator');
  process.env.FIRESTORE_EMULATOR_STARTED = 'true';
  connectFirestoreEmulator(firestore, '127.0.0.1', getFirebaseEmulatorPort('firestore'));
}
export default firestore;
export * from 'firebase/firestore';
