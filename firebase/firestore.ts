/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore/lite';
import firebase, { isDevelopment } from './firebase';
const firestore = getFirestore(firebase);
if (isDevelopment && process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Firestore emulator');
  process.env.FIRESTORE_EMULATOR_STARTED = 'true';
  connectFirestoreEmulator(firestore, 'localhost', 8080);
}
export default firestore;
export * from 'firebase/firestore/lite';
