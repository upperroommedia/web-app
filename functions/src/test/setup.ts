/**
 * Jest setup file for Firebase Functions tests
 * This file runs before all tests and configures Firebase Admin SDK to use the emulator
 * 
 * When running with `firebase emulators:exec`, the emulators are started automatically.
 * This setup ensures the Admin SDK connects to them.
 */

// Set environment variables for Firebase emulators BEFORE importing firebase-admin
// This ensures the Admin SDK connects to the emulators
// These are set automatically by firebase emulators:exec, but we set them here as fallback
// For tests, we use ports 18081 (Firestore) and 9100 (Auth) to avoid conflicts with dev emulator (8081, 9099)
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18081';
}
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9100';
}
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';
}
if (!process.env.GCLOUD_PROJECT) {
  process.env.GCLOUD_PROJECT = 'urm-app';
}
if (!process.env.ROLE_REQUEST_RECIPIENTS) {
  process.env.ROLE_REQUEST_RECIPIENTS = '["test-role-alerts@example.test"]';
}
if (!process.env.RUNTIME_ALERT_RECIPIENTS) {
  process.env.RUNTIME_ALERT_RECIPIENTS = '["test-runtime-alerts@example.test"]';
}
if (!process.env.ADMIN_BASE_URL) {
  process.env.ADMIN_BASE_URL = 'http://localhost:3000';
}

// Import and initialize Firebase Admin
import * as firebaseAdmin from 'firebase-admin';

// Initialize Firebase Admin if not already initialized
if (!firebaseAdmin.apps.length) {
  try {
    firebaseAdmin.initializeApp({
      projectId: 'urm-app',
      storageBucket: 'urm-app.appspot.com',
      databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/',
    });
    
    // Only log in verbose mode
    if (process.env.VERBOSE) {
      console.log('✓ Firebase Admin SDK initialized for tests');
      console.log('  Firestore Emulator:', process.env.FIRESTORE_EMULATOR_HOST);
      console.log('  Auth Emulator:', process.env.FIREBASE_AUTH_EMULATOR_HOST);
      console.log('  RTDB Emulator:', process.env.FIREBASE_DATABASE_EMULATOR_HOST);
    }
  } catch (error) {
    // Always log warnings/errors even in non-verbose mode
    console.warn('Firebase Admin already initialized or error:', error);
  }
}

export {};
