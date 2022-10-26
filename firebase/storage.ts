/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import firebase, { isDevelopment } from './firebase';

const storage = getStorage(firebase);
if (isDevelopment) {
  console.log('Connecting to Storage emulator');
  connectStorageEmulator(storage, 'localhost', 9199);
}
export default storage;
export * from 'firebase/storage';
