const DEFAULT_FIREBASE_PROJECT_ID = 'urm-app';
const DEFAULT_FUNCTIONS_REGION = 'us-central1';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

type FirebaseConfigEnv = {
  projectId?: string;
  databaseURL?: string;
  storageBucket?: string;
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

const getFirebaseConfigFromEnv = (): FirebaseConfigEnv => parseFirebaseConfigEnv() ?? {};

export const getFirebaseProjectId = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  process.env.FIREBASE_PROJECT_ID ||
  getFirebaseConfigFromEnv().projectId ||
  process.env.GCLOUD_PROJECT ||
  DEFAULT_FIREBASE_PROJECT_ID;

export const getFirebaseAuthDomain = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || `${getFirebaseProjectId()}.firebaseapp.com`;

export const getFirebaseStorageBucket = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
  process.env.FIREBASE_STORAGE_BUCKET ||
  getFirebaseConfigFromEnv().storageBucket ||
  `${getFirebaseProjectId()}.appspot.com`;

export const getFirebaseImagesBucket = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET ||
  process.env.FIREBASE_IMAGES_BUCKET ||
  `${getFirebaseProjectId()}-images`;

export const getFirebaseDatabaseUrl = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
  process.env.FIREBASE_DATABASE_URL ||
  getFirebaseConfigFromEnv().databaseURL ||
  `https://${getFirebaseProjectId()}-default-rtdb.firebaseio.com/`;

export const getFirebaseFunctionsRegion = (): string =>
  process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION ||
  process.env.FIREBASE_FUNCTIONS_REGION ||
  DEFAULT_FUNCTIONS_REGION;

export const getFirebaseFunctionsBaseUrl = (): string => {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL;
  if (configuredBaseUrl) {
    return trimTrailingSlash(configuredBaseUrl);
  }

  return `https://${getFirebaseFunctionsRegion()}-${getFirebaseProjectId()}.cloudfunctions.net`;
};

export const getFirebaseFunctionsEmulatorBaseUrl = (): string =>
  `http://127.0.0.1:5001/${getFirebaseProjectId()}/${getFirebaseFunctionsRegion()}`;
