/**
 * Script to create a dev admin user in the Firebase Auth emulator.
 * Run with:
 *   pnpm run create-dev-admin
 * or
 *   pnpm exec ts-node --skip-project --compiler-options '{"module":"commonjs"}' scripts/create-dev-admin.ts
 *
 * This script ONLY works when the Firebase emulator is running.
 */

/* eslint-disable no-console */
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FIREBASE_PROJECT_ID = 'urm-app';
const ENV_FILE_NAMES = ['.env', '.env.local'];

type FirebaseConfigEnv = {
  projectId?: string;
};

const parseFirebaseConfigEnv = (): FirebaseConfigEnv | null => {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) return null;

  if (raw.trim().startsWith('{')) {
    try {
      return JSON.parse(raw) as FirebaseConfigEnv;
    } catch {
      return null;
    }
  }

  return null;
};

const stripWrappingQuotes = (value: string): string => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
};

const parseEnvFile = (content: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    parsed[key] = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
  }
  return parsed;
};

const loadEnvFromFiles = (): Record<string, string> => {
  const loaded: Record<string, string> = {};
  for (const fileName of ENV_FILE_NAMES) {
    const absolutePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(absolutePath)) continue;
    const content = fs.readFileSync(absolutePath, 'utf8');
    Object.assign(loaded, parseEnvFile(content));
  }
  return loaded;
};

const fileEnv = loadEnvFromFiles();

const getFirebaseProjectId = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  fileEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  process.env.FIREBASE_PROJECT_ID ||
  fileEnv.FIREBASE_PROJECT_ID ||
  parseFirebaseConfigEnv()?.projectId ||
  process.env.GCLOUD_PROJECT ||
  DEFAULT_FIREBASE_PROJECT_ID;

// Set emulator host BEFORE initializing
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

// Initialize without credentials (emulator doesn't need them)
if (!admin.apps.length) {
  const projectId = getFirebaseProjectId();
  console.log(`[create-dev-admin] using Firebase project ${projectId}`);
  admin.initializeApp({
    projectId,
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
      console.error('   Make sure emulators are running: pnpm run emulators');
    } else {
      console.error('❌ Error creating dev admin:', err.message ?? error);
    }
    process.exit(1);
  }
}

createDevAdmin().then(() => process.exit(0));
