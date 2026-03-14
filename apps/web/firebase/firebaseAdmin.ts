import * as firebaseAdmin from 'firebase-admin';
import {
  getFirebaseDatabaseUrl,
  getFirebaseProjectId,
  getFirebaseStorageBucket,
} from '../shared/firebaseProjectConfig';

const isDevelopment = process.env.NODE_ENV === 'development';
const projectId = getFirebaseProjectId();

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.warn('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }

  firebaseAdmin.initializeApp({
    projectId,
    storageBucket: getFirebaseStorageBucket(),
    databaseURL: getFirebaseDatabaseUrl(),
  });
}
export default firebaseAdmin;
