/* eslint-disable no-console */
/* eslint-disable import/export */
import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

export const isDevelopment = process.env.NODE_ENV === 'development';
// Your web app's Firebase configuration
// These keys are ok to leave public according to Firebase docs
// Initialize Firebase

function createFirebaseApp() {
  if (getApps().length === 0) {
    if (isDevelopment) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    }
    return initializeApp({
      apiKey: 'AIzaSyCJKArKBX02ItsUD1zDJVC6JRA4sho7PTo',
      authDomain: 'urm-app.firebaseapp.com',
      projectId: 'urm-app',
      storageBucket: 'urm-app.appspot.com',
      messagingSenderId: '747878690617',
      appId: '1:747878690617:web:d29679a2961a60f31b82e8',
      measurementId: 'G-3PE6CE9N0H',
      databaseURL: isDevelopment
        ? 'http://127.0.0.1:9000/?ns=urm-app-default-rtdb'
        : 'https://urm-app-default-rtdb.firebaseio.com/',
    });
  } else {
    return getApp();
  }
}
const firebase = createFirebaseApp();
export const functions = getFunctions(firebase);
export const firestore = getFirestore(firebase);
export const storage = getStorage(firebase);
export const imageStorage = getStorage(firebase, 'urm-app-images');
export const database = getDatabase(firebase);
export const auth = getAuth(firebase);

// Connect to emulators if in development
if (isDevelopment) {
  if (process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
    console.log('Connecting to Firestore emulator');
    process.env.FIRESTORE_EMULATOR_STARTED = 'true';
    connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  }

  if (process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
    console.log('Connecting to Database emulator');
    process.env.FIRESTORE_EMULATOR_STARTED = 'true';
    connectDatabaseEmulator(database, '127.0.0.1', 9000);
  }

  if (process.env.AUTH_EMULATOR_STARTED !== 'true') {
    console.log('Connecting to Auth emulator');
    process.env.AUTH_EMULATOR_STARTED = 'true';
    connectAuthEmulator(auth, 'http://127.0.0.1:9099');
  }

  if (process.env.FUNCTIONS_EMULATOR_STARTED !== 'true') {
    console.log('Connecting to Functions emulator');
    process.env.FUNCTIONS_EMULATOR_STARTED = 'true';
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }

  if (process.env.STORAGE_EMULATOR_STARTED !== 'true') {
    console.log('Connecting to Storage emulator');
    process.env.STORAGE_EMULATOR_STARTED = 'true';
    connectStorageEmulator(storage, '127.0.0.1', 9199);
    connectStorageEmulator(imageStorage, '127.0.0.1', 9199);
  }
}

export default firebase;
export * from 'firebase/app';
