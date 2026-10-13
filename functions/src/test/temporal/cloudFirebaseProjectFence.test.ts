import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockApps: Array<{ name: string; options: { projectId?: string } }> = [];
const mockInitializeApp = jest.fn((options: { projectId?: string }) => {
  const app = { name: '[DEFAULT]', options };
  mockApps.push(app);
  return app;
});
const mockGetApp = jest.fn(() => {
  const app = mockApps.find((candidate) => candidate.name === '[DEFAULT]');
  if (!app) throw new Error('No default app');
  return app;
});
jest.mock('firebase-admin/app', () => ({
  getApps: () => mockApps,
  getApp: () => mockGetApp(),
  initializeApp: (options: { projectId?: string }) => mockInitializeApp(options),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: jest.fn() }));
jest.mock('firebase-admin/database', () => ({ getDatabase: jest.fn() }));
jest.mock('firebase-admin/storage', () => ({ getStorage: jest.fn() }));

const originalEnv = { ...process.env };
const cleanKeys = [
  'TEMPORAL_CONNECTION_MODE',
  'FIREBASE_PROJECT_ID',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'FIREBASE_CONFIG',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_DATABASE_URL',
  'FIREBASE_DATABASE_URL',
];
const load = () => jest.isolateModules(() => require('@upperroom/shared/firebase/firebaseAdmin'));
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of cleanKeys) delete process.env[key];
  process.env.NODE_ENV = 'production';
  process.env.TEMPORAL_CONNECTION_MODE = 'temporal-cloud';
  process.env.FIREBASE_PROJECT_ID = 'urm-app-staging';
  mockApps = [];
  jest.clearAllMocks();
});
afterEach(() => {
  process.env = { ...originalEnv };
});

test.each(['urm-app', 'urm-app-staging'])('initializes only the explicit reviewed Cloud project %s', (projectId) => {
  process.env.FIREBASE_PROJECT_ID = projectId;
  load();
  expect(mockInitializeApp).toHaveBeenCalledTimes(1);
  expect(mockInitializeApp).toHaveBeenCalledWith({
    projectId,
    storageBucket: `${projectId}.appspot.com`,
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com/`,
  });
});
test('reuses the matching default app without initializing another', () => {
  mockApps = [{ name: '[DEFAULT]', options: { projectId: 'urm-app-staging' } }];
  load();
  expect(mockInitializeApp).not.toHaveBeenCalled();
});
test.each(['urm-app', undefined])(
  'rejects an existing app bound to %s before initializing or exporting services',
  (projectId) => {
    mockApps = [{ name: '[DEFAULT]', options: { projectId } }];
    expect(load).toThrow('existing Firebase app belongs to another project');
    expect(mockInitializeApp).not.toHaveBeenCalled();
  }
);
test('does not silently reuse a named app as the default app', () => {
  mockApps = [{ name: 'other', options: { projectId: 'urm-app-staging' } }];
  expect(load).toThrow('No default app');
  expect(mockInitializeApp).not.toHaveBeenCalled();
});
test.each([undefined, '', 'unreviewed-project'])('rejects missing or unreviewed explicit Cloud project %s', (value) => {
  if (value === undefined) delete process.env.FIREBASE_PROJECT_ID;
  else process.env.FIREBASE_PROJECT_ID = value;
  expect(load).toThrow('explicit Firebase project binding');
  expect(mockInitializeApp).not.toHaveBeenCalled();
});
test.each(['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID'])(
  'rejects contradictory project source %s',
  (key) => {
    process.env[key] = 'urm-app';
    expect(load).toThrow(/project.*(conflicts|binding)/);
    expect(mockInitializeApp).not.toHaveBeenCalled();
  }
);
test.each([
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])('rejects Cloud emulator configuration %s', (key) => {
  process.env[key] = '127.0.0.1:9';
  expect(load).toThrow('development emulators');
  expect(mockInitializeApp).not.toHaveBeenCalled();
});
test('rejects development mode before implicit emulator setup', () => {
  process.env.NODE_ENV = 'development';
  expect(load).toThrow('development emulators');
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  expect(mockInitializeApp).not.toHaveBeenCalled();
});
test.each(['urm-app', null, 42])(
  'does not let the explicit fallback hide conflicting FIREBASE_CONFIG.projectId %s',
  (value) => {
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: value });
    expect(load).toThrow('configuration conflicts');
    expect(mockInitializeApp).not.toHaveBeenCalled();
  }
);
test('accepts matching inline Firebase configuration', () => {
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'urm-app-staging' });
  load();
  expect(mockInitializeApp).toHaveBeenCalledTimes(1);
});
test('checks Firebase configuration file contents rather than trusting the explicit fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urm-cloud-config-fence-'));
  const path = join(directory, 'firebase.json');
  process.env.FIREBASE_CONFIG = path;
  try {
    writeFileSync(path, JSON.stringify({ projectId: 'urm-app' }));
    expect(load).toThrow('configuration conflicts');
    expect(mockInitializeApp).not.toHaveBeenCalled();
    writeFileSync(path, JSON.stringify({ projectId: 'urm-app-staging' }));
    load();
    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});
test.each(['{invalid-json', '/missing/firebase-config-fence.json'])(
  'rejects unreadable or malformed Cloud Firebase configuration %s',
  (value) => {
    process.env.FIREBASE_CONFIG = value;
    expect(load).toThrow('cannot read valid Firebase configuration');
    expect(mockInitializeApp).not.toHaveBeenCalled();
  }
);
test('non-Cloud SDK behavior retains its existing configured project fallback', () => {
  delete process.env.TEMPORAL_CONNECTION_MODE;
  delete process.env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'generic-test-project' });
  load();
  expect(mockInitializeApp).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'generic-test-project' }));
});
