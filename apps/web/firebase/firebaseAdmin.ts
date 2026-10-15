import { isDemoEmulatorMode, assertDemoFirebaseApp } from '../../../packages/shared/firebase/demoEmulatorMode';
import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getStorage } from 'firebase-admin/storage';
import {
  getFirebaseDatabaseUrl,
  getFirebaseProjectId,
  getFirebaseStorageBucket,
} from '../shared/firebaseProjectConfig';

const isDevelopment = process.env.NODE_ENV === 'development';
const projectId = getFirebaseProjectId();

if (isDemoEmulatorMode && getApps().length) assertDemoFirebaseApp(getApp().options, true);

if (!getApps().length) {
  if (isDevelopment) {
    console.warn('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${getFirebaseEmulatorPort('auth')}`;
  }

  initializeApp({
    projectId,
    storageBucket: getFirebaseStorageBucket(),
    databaseURL: getFirebaseDatabaseUrl(),
  });
}
// The application exposes only its configured services; SDK types and static
// helpers are imported directly from their modular firebase-admin entry points.
const firebaseAdmin = {
  app: getApp,
  auth: getAuth,
  firestore: getFirestore,
  database: getDatabase,
  storage: getStorage,
};
export default firebaseAdmin;
