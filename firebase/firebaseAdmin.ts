import * as firebaseAdmin from 'firebase-admin';
import { isDevelopment } from './firebase';

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.log('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }

  firebaseAdmin.initializeApp({
    databaseURL: `https://urm-app.firebaseio.com`,
  });
}
export default firebaseAdmin;
