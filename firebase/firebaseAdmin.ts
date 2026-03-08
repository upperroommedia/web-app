import * as firebaseAdmin from 'firebase-admin';

const isDevelopment = process.env.NODE_ENV === 'development';

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    console.log('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }

  firebaseAdmin.initializeApp({
    storageBucket: 'urm-app.appspot.com',
    databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/',
  });
}
export default firebaseAdmin;
