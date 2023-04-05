import * as firebaseAdmin from 'firebase-admin';
import { isDevelopment } from './firebase';

/* eslint-disable no-console */
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const projectId = process.env.FIREBASE_PROJECT_ID;

if (privateKey === undefined || clientEmail === undefined || projectId === undefined) {
  console.log(
    `Failed to load Firebase credentials. Follow the instructions in the README to set your Firebase credentials inside environment variables.`
  );
}
let firstInitialization = false;

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.log('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }
  firstInitialization = true;
  firebaseAdmin.initializeApp({
    serviceAccountId: clientEmail,
    storageBucket: 'urm-app.appspot.com',
    projectId,
    databaseURL: isDevelopment
      ? 'http://127.0.0.1:9000/?ns=urm-app-default-rtdb'
      : 'https://urm-app-default-rtdb.firebaseio.com/',
  });
}

export const db = firebaseAdmin.firestore();
if (firstInitialization) {
  db.settings({ ignoreUndefinedProperties: true });
}
export const realtimeDB = firebaseAdmin.database();
export const storage = firebaseAdmin.storage();
export const auth = firebaseAdmin.auth();

export default firebaseAdmin;
