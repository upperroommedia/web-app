/* eslint-disable import/export */
import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';

export const isDevelopment = process.env.NODE_ENV === 'development';
// Your web app's Firebase configuration
// These keys are ok to leave public according to Firebase docs
// Initialize Firebase
const apps = getApps();
let firebase: FirebaseApp;
if (!apps.length) {
  firebase = initializeApp({
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
  firebase = apps[0];
}
export const analytics = isSupported().then((value) => (value ? getAnalytics(firebase) : null));
export default firebase as FirebaseApp;
export * from 'firebase/app';
