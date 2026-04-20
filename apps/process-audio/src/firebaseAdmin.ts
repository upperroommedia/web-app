import firebaseAdmin from 'firebase-admin';
import { applicationDefault, cert } from 'firebase-admin/app';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import logger from './WinstonLogger';
const isDevelopment = process.env.NODE_ENV === 'development';
const DEFAULT_FIREBASE_PROJECT_ID = 'urm-app';

const resolveFirebaseProjectId = (): string =>
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.PROJECT_ID ||
  DEFAULT_FIREBASE_PROJECT_ID;

type FirebaseConfigEnv = {
  projectId?: string;
  storageBucket?: string;
  databaseURL?: string;
};

type ServiceAccountEnv = {
  project_id: string;
  client_email: string;
  private_key: string;
};

const parseFirebaseConfigEnv = (): FirebaseConfigEnv | null => {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw || !raw.trim().startsWith('{')) return null;
  try {
    return JSON.parse(raw) as FirebaseConfigEnv;
  } catch {
    return null;
  }
};

const getFirebaseConfigFromEnv = (): FirebaseConfigEnv => parseFirebaseConfigEnv() ?? {};

const parseServiceAccountFromEnv = (): ServiceAccountEnv | null => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    return null;
  }

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<ServiceAccountEnv>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('missing required service account fields');
    }
    return parsed as ServiceAccountEnv;
  } catch (error) {
    logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const ensureGoogleApplicationCredentialsFile = (serviceAccount: ServiceAccountEnv): string => {
  const credentialsPath = join(tmpdir(), `process-audio-${serviceAccount.project_id}-adc.json`);
  const serialized = `${JSON.stringify(serviceAccount, null, 2)}\n`;

  if (!existsSync(credentialsPath) || readFileSync(credentialsPath, 'utf8') !== serialized) {
    writeFileSync(credentialsPath, serialized, { encoding: 'utf8', mode: 0o600 });
    chmodSync(credentialsPath, 0o600);
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  }

  return credentialsPath;
};

const resolveStorageBucket = (projectId: string): string =>
  process.env.FIREBASE_STORAGE_BUCKET || getFirebaseConfigFromEnv().storageBucket || `${projectId}.appspot.com`;

const resolveDatabaseUrl = (projectId: string): string => {
  const databaseInstance = process.env.FIREBASE_DATABASE_INSTANCE || `${projectId}-default-rtdb`;
  if (isDevelopment && process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    return `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${databaseInstance}`;
  }
  return process.env.FIREBASE_DATABASE_URL || getFirebaseConfigFromEnv().databaseURL || `https://${databaseInstance}.firebaseio.com/`;
};

if (!firebaseAdmin.apps.length) {
  const firebaseProjectId = resolveFirebaseProjectId();
  const storageBucket = resolveStorageBucket(firebaseProjectId);
  const serviceAccount = !isDevelopment ? parseServiceAccountFromEnv() : null;

  if (isDevelopment) {
    logger.info('Setting Admin SDK to use emulator');
    // Use environment variables if set, otherwise default to localhost
    // For Docker, set these to host.docker.internal (Mac/Windows) or host IP (Linux)
    const emulatorHost = process.env.FIREBASE_EMULATOR_HOST || '127.0.0.1';
    const firestorePort = process.env.FIRESTORE_EMULATOR_PORT || '8080';
    const authPort = process.env.FIREBASE_AUTH_EMULATOR_PORT || '9099';
    const storagePort = process.env.FIREBASE_STORAGE_EMULATOR_PORT || '9199';
    const databasePort = process.env.FIREBASE_DATABASE_EMULATOR_PORT || '9000';

    const authHost = `${emulatorHost}:${authPort}`;
    const firestoreHost = `${emulatorHost}:${firestorePort}`;
    const storageHost = `${emulatorHost}:${storagePort}`;
    const databaseHost = `${emulatorHost}:${databasePort}`;

    process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
    process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = storageHost;
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = databaseHost;

    logger.info('Emulator configuration', {
      emulatorHost,
      auth: {
        host: authHost,
        url: `http://${authHost}`,
      },
      firestore: {
        host: firestoreHost,
        url: `http://${firestoreHost}`,
      },
      storage: {
        host: storageHost,
        url: `http://${storageHost}`,
      },
      database: {
        host: databaseHost,
        url: `http://${databaseHost}`,
      },
    });
  } else {
    if (serviceAccount) {
      const credentialsPath = ensureGoogleApplicationCredentialsFile(serviceAccount);
      logger.info('Configured production ADC from FIREBASE_SERVICE_ACCOUNT_JSON', {
        firebaseProjectId,
        clientEmail: serviceAccount.client_email,
        credentialsPath,
      });
    }

    logger.info('Using non-emulator Firebase services', {
      firebaseProjectId,
      storageBucket,
      databaseURL: process.env.FIREBASE_DATABASE_URL || '(derived from project)',
    });
  }

  // Configure databaseURL for emulator or production
  const databaseURL = resolveDatabaseUrl(firebaseProjectId);

  if (isDevelopment) {
    logger.info('Database URL configured', { firebaseProjectId, storageBucket, databaseURL });
  }

  // In development with emulators, we don't need real credentials
  // In production, we need real credentials
  const initConfig: {
    projectId: string;
    storageBucket: string;
    databaseURL: string;
    credential?: ReturnType<typeof applicationDefault> | ReturnType<typeof cert>;
  } = {
    projectId: firebaseProjectId, // Required for emulators to work properly
    storageBucket,
    databaseURL,
  };

  if (!isDevelopment) {
    // Only add credentials in production
    initConfig.credential = serviceAccount
      ? cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        })
      : applicationDefault();
  }

  firebaseAdmin.initializeApp(initConfig);
}
export default firebaseAdmin;
