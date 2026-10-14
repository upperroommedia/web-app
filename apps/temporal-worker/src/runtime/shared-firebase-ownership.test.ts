const mockCreated = { name: '[DEFAULT]', options: { projectId: 'urm-app' } };
let mockApps: Array<typeof mockCreated> = [];
const mockInitialize = jest.fn(() => {
  mockApps.push(mockCreated);
  return mockCreated;
});
const mockTerminate = jest.fn(async () => undefined);
const mockGetFirestore = jest.fn((_app: unknown) => ({ terminate: mockTerminate }));
const mockDelete = jest.fn(async (app: unknown) => {
  mockApps = mockApps.filter((current) => current !== app);
});
jest.mock('firebase-admin/app', () => ({
  getApps: () => [...mockApps],
  getApp: () => mockApps[0],
  initializeApp: () => mockInitialize(),
  deleteApp: (app: unknown) => mockDelete(app),
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: (app: unknown) => mockGetFirestore(app) }));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
jest.mock('firebase-admin/database', () => ({ getDatabase: jest.fn() }));
jest.mock('firebase-admin/storage', () => ({ getStorage: jest.fn() }));
const original = { ...process.env };
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockApps = [];
  process.env.NODE_ENV = 'test';
  process.env.FIREBASE_PROJECT_ID = 'urm-app';
  delete process.env.TEMPORAL_CONNECTION_MODE;
});
afterEach(() => {
  process.env = { ...original };
});

test('creator registry is inert before actual shared initialization, then binds teardown to that SDK identity', async () => {
  const registry = await import('@upperroom/shared/firebase/firebaseAdminOwnership');
  expect(registry.getSharedFirebaseAppOwnership()).toBeUndefined();
  expect(mockInitialize).not.toHaveBeenCalled();
  await import('@upperroom/shared/firebase/firebaseAdmin');
  const owned = registry.getSharedFirebaseAppOwnership()!;
  expect(owned.app).toBe(mockCreated);
  expect(owned.isRegistered()).toBe(true);
  await owned.terminateFirestore();
  expect(mockGetFirestore).toHaveBeenCalledWith(mockCreated);
  await owned.deleteApp();
  expect(mockDelete).toHaveBeenCalledWith(mockCreated);
  expect(owned.isRegistered()).toBe(false);
});

test('shared wrapper never claims a supplied app and detects replacement of its own app', async () => {
  mockApps = [{ name: '[DEFAULT]', options: { projectId: 'urm-app' } }];
  await import('@upperroom/shared/firebase/firebaseAdmin');
  const registry = await import('@upperroom/shared/firebase/firebaseAdminOwnership');
  expect(registry.getSharedFirebaseAppOwnership()).toBeUndefined();
  expect(mockInitialize).not.toHaveBeenCalled();
  jest.resetModules();
  mockApps = [];
  await import('@upperroom/shared/firebase/firebaseAdmin');
  const owned = (await import('@upperroom/shared/firebase/firebaseAdminOwnership')).getSharedFirebaseAppOwnership()!;
  mockApps = [{ name: '[DEFAULT]', options: { projectId: 'urm-app' } }];
  expect(owned.isRegistered()).toBe(false);
  expect(mockTerminate).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});
