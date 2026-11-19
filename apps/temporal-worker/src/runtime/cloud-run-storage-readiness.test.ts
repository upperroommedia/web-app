import { verifyCloudRunStorageReadiness } from './cloud-run-storage-readiness';

const mockCredential = {
  isComputeEngineCredential: jest.fn(),
  getServiceAccountEmail: jest.fn(),
  getAccessToken: jest.fn(),
};
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () => ({
    isRegistered: () => true,
    app: {
      name: '[DEFAULT]',
      options: { projectId: 'urm-app-staging', credential: mockCredential },
    },
  }),
}));

const witness = {
  buildId: 'a'.repeat(40),
  instanceId: 'process',
  cloudRun: {
    projectId: 'urm-app-staging',
    region: 'us-central1',
    pool: 'pool',
    revision: 'pool-00001',
    revisionUid: 'uid',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    serviceAccount: 'tw-i-aaaaaaaaaaaaaaaaaaaa@urm-app-staging.iam.gserviceaccount.com',
    instanceId: 'native',
  },
};
const permissions = ['storage.objects.get', 'storage.objects.update', 'storage.objects.delete'];
const denial = 'CLOUD_RUN_STORAGE_READINESS_UNCONFIRMED';
const mockFetch = jest.fn();
const emulatorNames = ['FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST'];
const originalEmulators = emulatorNames.map((name) => process.env[name]);

beforeEach(() => {
  // All network boundaries are mocked. Emulators cannot supply runtime proof.
  for (const name of emulatorNames) delete process.env[name];
  jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({
      kind: 'storage#testIamPermissionsResponse',
      permissions,
    }),
  });
  mockCredential.isComputeEngineCredential.mockReset().mockResolvedValue(true);
  mockCredential.getServiceAccountEmail.mockReset().mockResolvedValue(witness.cloudRun.serviceAccount);
  mockCredential.getAccessToken.mockReset().mockResolvedValue({ access_token: 'fixture-token' });
});
afterEach(() => {
  jest.restoreAllMocks();
  emulatorNames.forEach((name, index) => {
    const previous = originalEmulators[index];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
});
const probe = (signal = new AbortController().signal) => verifyCloudRunStorageReadiness('images', witness, signal);

test('queries only its exact bucket and required permissions using the attested account', async () => {
  const proof = await probe();
  expect(proof).toEqual({
    bucket: 'urm-app-staging-images',
    permissions: [...permissions].sort(),
    observedAt: expect.any(String),
  });
  const [[url, options]] = mockFetch.mock.calls;
  expect(url.origin + url.pathname).toBe(
    'https://storage.googleapis.com/storage/v1/b/urm-app-staging-images/iam/testPermissions'
  );
  expect([...url.searchParams.entries()]).toEqual(
    [...permissions].sort().map((permission) => ['permissions', permission])
  );
  expect(options).toEqual({
    headers: { Authorization: 'Bearer fixture-token' },
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
});

test.each([
  permissions.slice(1),
  [...permissions, 'storage.objects.create'],
  [permissions[0], permissions[0], permissions[1]],
])('rejects partial, unexpected or duplicate granted permissions', async (...granted) => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      kind: 'storage#testIamPermissionsResponse',
      permissions: granted,
    }),
  });
  await expect(probe()).rejects.toThrow(denial);
});

test('rejects credential mismatch and a configured emulator before calling Storage', async () => {
  mockCredential.getServiceAccountEmail.mockResolvedValueOnce('wrong@example.test');
  await expect(probe()).rejects.toThrow(denial);
  process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9099';
  await expect(probe()).rejects.toThrow(denial);
  expect(mockCredential.getAccessToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('cancellation while obtaining a token does not send the request', async () => {
  const controller = new AbortController();
  mockCredential.getAccessToken.mockImplementation(() => {
    controller.abort();
    return new Promise(() => {});
  });
  await expect(probe(controller.signal)).rejects.toThrow(denial);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('email and search need no Storage probe', async () => {
  for (const role of ['email', 'search'] as const) {
    await expect(verifyCloudRunStorageReadiness(role, witness, new AbortController().signal)).resolves.toBeNull();
  }
  expect(mockFetch).not.toHaveBeenCalled();
});
