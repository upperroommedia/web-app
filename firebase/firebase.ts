/* eslint-disable import/export */
import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import {
  getFirebaseAuthDomain,
  getFirebaseDatabaseUrl,
  getFirebaseProjectId,
  getFirebaseStorageBucket,
} from '../shared/firebaseProjectConfig';

export const isDevelopment = process.env.NODE_ENV === 'development';
// Your web app's Firebase configuration
// These keys are ok to leave public according to Firebase docs
// Initialize Firebase
const apps = getApps();
let firebase: FirebaseApp;
const projectId = getFirebaseProjectId();
if (!apps.length) {
  firebase = initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'AIzaSyCJKArKBX02ItsUD1zDJVC6JRA4sho7PTo',
    authDomain: getFirebaseAuthDomain(),
    projectId,
    storageBucket: getFirebaseStorageBucket(),
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '747878690617',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '1:747878690617:web:d29679a2961a60f31b82e8',
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || 'G-3PE6CE9N0H',
    databaseURL: isDevelopment
      ? `http://127.0.0.1:9000/?ns=${projectId}-default-rtdb`
      : getFirebaseDatabaseUrl(),
  });
} else {
  firebase = apps[0];
}
export const analytics = isSupported().then((value) => (value ? getAnalytics(firebase) : null));
export default firebase as FirebaseApp;
export * from 'firebase/app';
