/* eslint-disable no-console */
 
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import firebase, { isDevelopment } from './firebase';

const firestore =
  typeof window === 'undefined'
    ? getFirestore(firebase)
    : (() => {
        try {
          return initializeFirestore(firebase, {
            localCache: persistentLocalCache({
              tabManager: persistentMultipleTabManager(),
            }),
          });
        } catch (error) {
          console.warn('Falling back to default Firestore cache configuration.', error);
          return getFirestore(firebase);
        }
      })();

if (isDevelopment && process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Firestore emulator');
  process.env.FIRESTORE_EMULATOR_STARTED = 'true';
  connectFirestoreEmulator(firestore, '127.0.0.1', 8081);
}
export default firestore;
export * from 'firebase/firestore';
