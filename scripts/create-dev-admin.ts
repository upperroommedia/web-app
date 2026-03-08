/**
 * Script to create a dev admin user in the Firebase Auth emulator.
 * Run with: npx ts-node --skip-project scripts/create-dev-admin.ts
 * 
 * This script ONLY works when the Firebase emulator is running.
 */

/* eslint-disable no-console */
import admin from 'firebase-admin';

// Set emulator host BEFORE initializing
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

// Initialize without credentials (emulator doesn't need them)
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'urm-app',
  });
}

const DEV_ADMIN_EMAIL = 'dev-admin@test.local';
const DEV_ADMIN_PASSWORD = 'devadmin123';

type ErrorWithCode = {
  code?: string;
  message?: string;
};

async function createDevAdmin() {
  const auth = admin.auth();
  
  try {
    // Check if user already exists
    const existingUser = await auth.getUserByEmail(DEV_ADMIN_EMAIL).catch(() => null);
    
    if (existingUser) {
      console.log('✅ Dev admin user already exists');
      console.log(`   Email: ${DEV_ADMIN_EMAIL}`);
      console.log(`   UID: ${existingUser.uid}`);
      
      // Ensure admin role is set
      await auth.setCustomUserClaims(existingUser.uid, { role: 'admin' });
      console.log('✅ Admin role confirmed');
      return;
    }

    // Create new user
    const userRecord = await auth.createUser({
      email: DEV_ADMIN_EMAIL,
      password: DEV_ADMIN_PASSWORD,
      displayName: 'Dev Admin',
      emailVerified: true,
    });

    // Set admin role
    await auth.setCustomUserClaims(userRecord.uid, { role: 'admin' });

    console.log('✅ Dev admin user created successfully!');
    console.log('');
    console.log('   Credentials:');
    console.log(`   Email: ${DEV_ADMIN_EMAIL}`);
    console.log(`   Password: ${DEV_ADMIN_PASSWORD}`);
    console.log(`   UID: ${userRecord.uid}`);
    console.log('');
    console.log('   You can now use the "Dev Login" button on the login page.');

  } catch (error: unknown) {
    const err = error as ErrorWithCode;
    const isConnectionError =
      err.code === 'ECONNREFUSED' ||
      err.code === 'app/network-error' ||
      (err.message?.includes('ECONNREFUSED') ?? false);

    if (isConnectionError) {
      console.error('❌ Could not connect to Firebase Auth emulator.');
      console.error('   Make sure the emulator is running: pnpm run start-emulators');
    } else {
      console.error('❌ Error creating dev admin:', err.message ?? error);
    }
    process.exit(1);
  }
}

createDevAdmin().then(() => process.exit(0));
