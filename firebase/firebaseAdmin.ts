import * as firebaseAdmin from 'firebase-admin';
import { isDevelopment } from './firebase';

const privateKey = process.env.PRIVATE_KEY;
const clientEmail = process.env.CLIENT_EMAIL;
const projectId = process.env.PROJECT_ID;

if (!privateKey || !clientEmail || !projectId) {
  // eslint-disable-next-line no-console
  console.log(
    `Failed to load Firebase credentials. Follow the instructions in the README to set your Firebase credentials inside environment variables.`
  );
}

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.log('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
  }
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert({
      projectId: projectId,
      privateKey: privateKey,
      clientEmail: clientEmail,
    }),
    databaseURL: `https://${projectId}.firebaseio.com`,
  });
}
export default firebaseAdmin;
