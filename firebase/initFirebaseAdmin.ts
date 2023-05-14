import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { isDevelopment } from './firebase';

function createFirebaseAdminApp() {
  if (getApps().length === 0) {
    return initializeApp();
  } else {
    return getApp();
  }
}

const firebaseAdmin = createFirebaseAdminApp();
export const adminAuth = getAuth(firebaseAdmin);
export const adminFirestore = getFirestore(firebaseAdmin);
export const adminStorage = getStorage(firebaseAdmin);
export const adminDatabase = getDatabaseWithUrl(
  isDevelopment ? 'http://127.0.0.1:9000/?ns=urm-app-default-rtdb' : 'https://urm-app-default-rtdb.firebaseio.com/'
);
