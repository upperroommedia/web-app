/* eslint-disable no-console */
 
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import firebase, { isDevelopment } from './firebase';
import { getFirebaseImagesBucket } from '../shared/firebaseProjectConfig';

const storage = getStorage(firebase);
export const imageStorage = getStorage(firebase, getFirebaseImagesBucket());

if (isDevelopment) {
  console.log('Connecting to Storage emulator');
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectStorageEmulator(imageStorage, '127.0.0.1', 9199);
}
export default storage;
export * from 'firebase/storage';
