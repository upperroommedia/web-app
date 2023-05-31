import * as firebaseAdmin from 'firebase-admin';
import { isDevelopment } from './firebase';

/* eslint-disable no-console */
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const projectId = process.env.FIREBASE_PROJECT_ID;

if (!privateKey || !clientEmail || !projectId) {
  console.log(
    `Failed to load Firebase credentials. Follow the instructions in the README to set your Firebase credentials inside environment variables.`
  );
}

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.log('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }

  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert({
      projectId,
      privateKey,
      clientEmail,
    }),
    databaseURL: `https://${projectId}.firebaseio.com`,
  });
}
export default firebaseAdmin;
