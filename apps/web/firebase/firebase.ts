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

interface FirebaseDefaultsConfig {
  apiKey?: string;
  appId?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

const getFirebaseDefaultsConfig = (): FirebaseDefaultsConfig => {
  if (typeof globalThis === 'undefined') {
    return {};
  }

  const defaults = (globalThis as { __FIREBASE_DEFAULTS__?: { config?: FirebaseDefaultsConfig } }).__FIREBASE_DEFAULTS__;
  return defaults?.config ?? {};
};
if (!apps.length) {
  const defaults = getFirebaseDefaultsConfig();
  firebase = initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || defaults.apiKey || '',
    authDomain: getFirebaseAuthDomain(),
    projectId,
    storageBucket: getFirebaseStorageBucket(),
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || defaults.messagingSenderId || '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || defaults.appId || '',
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || defaults.measurementId,
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
