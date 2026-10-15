import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from '../../../packages/shared/firebase/demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
/* eslint-disable no-console */

import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { getFirebaseImagesBucket } from '../shared/firebaseProjectConfig';

const storage = getStorage(firebase);
export const imageStorage = getStorage(firebase, getFirebaseImagesBucket());

if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('storage', storage, () =>
    connectStorageEmulator(storage, '127.0.0.1', getFirebaseEmulatorPort('storage'))
  );
  connectDemoFirebaseEmulator('storage', imageStorage, () =>
    connectStorageEmulator(imageStorage, '127.0.0.1', getFirebaseEmulatorPort('storage'))
  );
} else if (isEmulatorMode) {
  console.log('Connecting to Storage emulator');
  connectStorageEmulator(storage, '127.0.0.1', getFirebaseEmulatorPort('storage'));
  connectStorageEmulator(imageStorage, '127.0.0.1', getFirebaseEmulatorPort('storage'));
}
export default storage;
export * from 'firebase/storage';
