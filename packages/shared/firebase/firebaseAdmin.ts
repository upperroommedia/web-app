import { isDemoEmulatorMode, assertDemoFirebaseApp } from './demoEmulatorMode';
import { getFirebaseEmulatorPort } from './emulatorPorts';
import { readFileSync } from 'node:fs';
import { getApp, getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { recordSharedFirebaseAppCreation } from './firebaseAdminOwnership';
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
const isTemporalCloud = process.env.TEMPORAL_CONNECTION_MODE === 'temporal-cloud';

if (isTemporalCloud) {
  const explicitProject = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!explicitProject || !['urm-app', 'urm-app-staging'].includes(explicitProject) || projectId !== explicitProject) {
    throw new Error('Temporal Cloud requires its explicit Firebase project binding');
  }
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID']) {
    const value = process.env[key]?.trim();
    if (value && value !== explicitProject) throw new Error('Temporal Cloud Firebase project configuration conflicts');
  }
  // Admin accepts FIREBASE_CONFIG as inline JSON or a JSON file path. The shared
  // getter's explicit-project fallback must not hide a conflicting configuration.
  const rawConfig = process.env.FIREBASE_CONFIG?.trim();
  if (rawConfig) {
    let firebaseConfig: unknown;
    try {
      firebaseConfig = JSON.parse(rawConfig.startsWith('{') ? rawConfig : readFileSync(rawConfig, 'utf8'));
    } catch {
      throw new Error('Temporal Cloud cannot read valid Firebase configuration');
    }
    if (!firebaseConfig || typeof firebaseConfig !== 'object' || Array.isArray(firebaseConfig)) {
      throw new Error('Temporal Cloud requires an object Firebase configuration');
    }
    const configProject = (firebaseConfig as { projectId?: unknown }).projectId;
    if (configProject !== undefined && configProject !== explicitProject) {
      throw new Error('Temporal Cloud Firebase project configuration conflicts');
    }
  }
  if (
    isDevelopment ||
    [
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
    ].some((key) => Boolean(process.env[key]))
  ) {
    throw new Error('Temporal Cloud cannot initialize Firebase development emulators');
  }
  if (getApps().length && getApp().options.projectId !== explicitProject) {
    throw new Error('Temporal Cloud existing Firebase app belongs to another project');
  }
}

if (isDemoEmulatorMode && getApps().length) assertDemoFirebaseApp(getApp().options, true);

if (!getApps().length) {
  if (isDevelopment) {
    console.warn('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${getFirebaseEmulatorPort('auth')}`;
  }

  const createdApp = initializeApp({
    projectId,
    storageBucket: getFirebaseStorageBucket(),
    databaseURL: getFirebaseDatabaseUrl(),
  });
  recordSharedFirebaseAppCreation({
    app: createdApp,
    isRegistered: () => getApps().includes(createdApp),
    terminateFirestore: () => getFirestore(createdApp).terminate(),
    deleteApp: () => deleteApp(createdApp),
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
