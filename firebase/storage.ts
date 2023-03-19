/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import firebase, { isDevelopment } from './firebase';

const storage = getStorage(firebase);
export const imageStorage = getStorage(firebase, 'urm-app-images');

if (isDevelopment) {
  console.log('Connecting to Storage emulator');
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectStorageEmulator(imageStorage, '127.0.0.1', 9199);
}
export default storage;
export * from 'firebase/storage';
