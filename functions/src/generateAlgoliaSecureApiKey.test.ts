import { createHmac } from 'crypto';
import { algoliasearch } from 'algoliasearch';
import {
  STAGING_SEARCH_APPLICATION_ID,
  STAGING_SEARCH_PROJECT_ID,
  STAGING_SEARCH_SCHEMA_SHA256,
  STAGING_SEARCH_READINESS_PATH,
} from '@upperroom/contracts/stagingSearchReadiness';

jest.mock('algoliasearch', () => {
  const actual = jest.requireActual('algoliasearch');
  return { ...actual, algoliasearch: jest.fn(actual.algoliasearch) };
});
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { GenerateSecuredApiKeyOutputType } from '@upperroom/contracts/generateAlgoliaSecureApiKey';

const mockGetUser = jest.fn();
const mockApp = jest.fn();
const mockRunTransaction = jest.fn();
const mockReadDocuments = jest.fn();
let mockControl: unknown;
let mockReadiness: unknown;
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ getUser: mockGetUser }),
    app: () => mockApp(),
    firestore: () => ({ doc: (path: string) => ({ path }), runTransaction: mockRunTransaction }),
  },
}));
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  onCall: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('./algoliaSecrets', () => ({ algoliaSecretsWithRuntimeAlerts: [] }));
jest.mock('./handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
import generateSecuredApiKey, { SHARED_SEARCH_INDICES } from './generateAlgoliaSecureApiKey';

const generate = generateSecuredApiKey as unknown as (
  request: Partial<CallableRequest>
) => Promise<GenerateSecuredApiKeyOutputType>;
const auth = (role: string, uid = 'real-user') =>
  ({ uid, token: { role, auth_time: 1700000000 } } as unknown as CallableRequest['auth']);
const account = (role?: string) => ({
  disabled: false,
  customClaims: { role },
  tokensValidAfterTime: new Date(1600000000 * 1000).toUTCString(),
});
const decode = (key: string) => {
  const decoded = Buffer.from(key, 'base64').toString();
  const query = decoded.slice(64);
  expect(decoded.slice(0, 64)).toBe(createHmac('sha256', 'secret-parent-test').update(query).digest('hex'));
  return new URLSearchParams(query);
};

describe('authenticated search key scopes', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.ALGOLIA_SEARCH_API_KEY = 'secret-parent-test';
    process.env.ALGOLIA_APP_ID = 'test-app';
    mockGetUser.mockReset().mockResolvedValue(account('uploader'));
    mockApp.mockReset().mockReturnValue({ options: { projectId: 'urm-app' } });
    mockControl = undefined;
    mockReadiness = undefined;
    mockReadDocuments.mockReset().mockImplementation(async (...refs: Array<{ path: string }>) =>
      refs.map((ref) => ({
        data: () => (ref.path === '_control/temporalRelease' ? mockControl : mockReadiness),
      }))
    );
    mockRunTransaction.mockReset().mockImplementation(async (read) => read({ getAll: mockReadDocuments }));
    jest.mocked(algoliasearch).mockClear();
  });
  afterEach(() => {
    process.env = { ...original };
    jest.useRealTimers();
  });

  test.each(['uploader', 'publisher', 'admin'])('signs expiring exact index scopes for %s', async (role) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00Z'));
    mockGetUser.mockResolvedValue(account(role));
    const result = await generate({ auth: auth(role), data: { userId: 'victim' } });
    expect(mockGetUser).toHaveBeenCalledWith('real-user');
    const sermon = decode(result.apiKey);
    const shared = decode(result.sharedApiKey);
    expect(sermon.get('restrictIndices')).toBe('sermons');
    expect(sermon.get('filters')).toBe(role === 'admin' ? null : 'uploaderId:"real-user"');
    expect(sermon.get('userToken')).toBe('real-user');
    expect(Number(sermon.get('validUntil')) * 1000).toBe(result.expiresAt);
    expect(result.expiresAt).toBe(Date.now() + 5 * 60_000);
    expect(shared.get('restrictIndices')?.split(',')).toEqual(SHARED_SEARCH_INDICES);
    expect(shared.get('filters')).toBeNull();
    expect(shared.get('userToken')).toBe('real-user');
    expect(shared.get('validUntil')).toBe(sermon.get('validUntil'));
    expect([...result.sermonIndices, ...result.sharedIndices]).not.toContain('users');
    expect([...result.sermonIndices, ...result.sharedIndices].every((index) => !index.includes('*'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-parent-test');
  });

  test.each([undefined, 'user', 'unknown'])(
    'rejects current unprivileged role %s even with an old admin token',
    async (role) => {
      mockGetUser.mockResolvedValue(account(role));
      await expect(generate({ auth: auth('admin'), data: {} })).rejects.toThrow('not allowed');
    }
  );
  test('demoted admin receives only current uploader scope', async () => {
    const result = await generate({ auth: auth('admin'), data: {} });
    expect(decode(result.apiKey).get('filters')).toBe('uploaderId:"real-user"');
  });
  test('rejects disabled accounts and revoked sessions', async () => {
    mockGetUser.mockResolvedValue({ ...account('admin'), disabled: true });
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toThrow('not allowed');
    mockGetUser.mockResolvedValue({
      ...account('admin'),
      tokensValidAfterTime: new Date(1800000000 * 1000).toUTCString(),
    });
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toThrow('revoked');
  });
  test('matches Firebase revocation semantics for accounts with no revocation cutoff', async () => {
    mockGetUser.mockResolvedValue({ ...account('uploader'), tokensValidAfterTime: undefined });
    await expect(generate({ auth: auth('uploader'), data: {} })).resolves.toHaveProperty('apiKey');
    await expect(
      generate({ auth: { uid: 'real-user', token: { role: 'admin' } } as unknown as CallableRequest['auth'], data: {} })
    ).rejects.toThrow('revoked');
  });
  test('rejects anonymous callers and never falls back to public credentials', async () => {
    await expect(generate({ data: { userId: 'admin' } })).rejects.toThrow('not allowed');
    expect(mockGetUser).not.toHaveBeenCalled();
    delete process.env.ALGOLIA_SEARCH_API_KEY;
    process.env.NEXT_PUBLIC_ALGOLIA_API_KEY = 'legacy-public-key';
    await expect(generate({ auth: auth('uploader'), data: {} })).rejects.toThrow('Missing Algolia');
  });
  test('quotes UID filter values to prevent filter expression injection', async () => {
    const uid = 'x" OR uploaderId:other';
    const result = await generate({ auth: auth('uploader', uid), data: {} });
    expect(decode(result.apiKey).get('filters')).toBe(`uploaderId:${JSON.stringify(uid)}`);
  });
});

const readyMarker = () => ({
  schemaVersion: 1,
  projectId: STAGING_SEARCH_PROJECT_ID,
  appId: STAGING_SEARCH_APPLICATION_ID,
  recordSchemaSha256: STAGING_SEARCH_SCHEMA_SHA256,
  releaseId: '12345678-1234-4234-8234-123456789012',
  compatibilityCommit: 'a'.repeat(40),
  controlRevision: 7,
  jobIds: Array.from({ length: 5 }, (_, i) => `job-${String(i).repeat(48)}`),
  generations: [1, 1, 1, 1, 1],
  counts: [0, 3, 4, 5, 6],
  settingsReceiptCanonicalSha256: 'b'.repeat(64),
});

describe('staging runtime readiness gate', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.ALGOLIA_SEARCH_API_KEY = 'secret-parent-test';
    process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED = 'true';
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'obsolete-staging-app';
    mockApp.mockReturnValue({ options: { projectId: STAGING_SEARCH_PROJECT_ID } });
    mockGetUser.mockResolvedValue(account('admin'));
    mockControl = { schemaVersion: 1, revision: 7, domains: { search: { owner: 'temporal' } } };
    mockReadiness = readyMarker();
    mockReadDocuments.mockReset().mockImplementation(async (...refs: Array<{ path: string }>) =>
      refs.map((ref) => ({
        data: () => (ref.path === '_control/temporalRelease' ? mockControl : mockReadiness),
      }))
    );
    mockRunTransaction.mockReset().mockImplementation(async (read) => read({ getAll: mockReadDocuments }));
    jest.mocked(algoliasearch).mockClear();
  });
  afterEach(() => {
    process.env = { ...original };
  });

  test.each(['admin', 'uploader', 'publisher'])(
    'compiled enabled plus Temporal ownership cannot mint %s keys without a private readiness marker',
    async (role) => {
      mockGetUser.mockResolvedValue(account(role));
      mockReadiness = undefined;
      await expect(generate({ auth: auth(role), data: {} })).rejects.toMatchObject({ code: 'unavailable' });
      expect(algoliasearch).not.toHaveBeenCalled();
      expect(mockReadDocuments).toHaveBeenCalledWith(
        { path: '_control/temporalRelease' },
        { path: STAGING_SEARCH_READINESS_PATH }
      );
      expect(mockRunTransaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
    }
  );

  test.each([
    ['application', { appId: 'old-app' }],
    ['schema', { recordSchemaSha256: '0'.repeat(64) }],
    ['project', { projectId: 'urm-app' }],
    ['revision', { controlRevision: 8 }],
    ['job proof', { jobIds: [] }],
    ['generation proof', { generations: [0, 1, 1, 1, 1] }],
    ['count proof', { counts: [-1, 1, 1, 1, 1] }],
    ['settings proof', { settingsReceiptCanonicalSha256: '' }],
  ])('blocks a marker with invalid %s before constructing any signing client', async (_name, patch) => {
    mockReadiness = { ...readyMarker(), ...patch };
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(algoliasearch).not.toHaveBeenCalled();
  });

  test('blocks legacy ownership or unavailable control snapshots', async () => {
    mockControl = { schemaVersion: 1, revision: 7, domains: { search: { owner: 'legacy' } } };
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toMatchObject({ code: 'unavailable' });
    mockControl = undefined;
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toMatchObject({ code: 'unavailable' });
    mockReadDocuments.mockRejectedValueOnce(new Error('Firestore unavailable'));
    await expect(generate({ auth: auth('admin'), data: {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(algoliasearch).not.toHaveBeenCalled();
  });

  test('a valid marker authorizes the fixed staging application across later non-search releases', async () => {
    process.env.FIREBASE_PROJECT_ID = 'urm-app';
    mockControl = {
      schemaVersion: 1,
      revision: 14,
      selectedDomains: ['images'],
      state: 'completed',
      domains: { search: { owner: 'temporal' } },
    };
    const result = await generate({ auth: auth('admin'), data: {} });
    expect(algoliasearch).toHaveBeenCalledWith(STAGING_SEARCH_APPLICATION_ID, 'secret-parent-test');
    expect(decode(result.apiKey).get('restrictIndices')).toBe('sermons');
    expect(decode(result.sharedApiKey).get('restrictIndices')).not.toContain('users');
  });

  test('actual Firebase project controls the gate; production does not read staging readiness', async () => {
    mockApp.mockReturnValue({ options: { projectId: 'urm-app' } });
    process.env.FIREBASE_PROJECT_ID = STAGING_SEARCH_PROJECT_ID;
    mockReadiness = undefined;
    await expect(generate({ auth: auth('admin'), data: {} })).resolves.toHaveProperty('apiKey');
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(algoliasearch).toHaveBeenCalledWith('obsolete-staging-app', 'secret-parent-test');
  });
});
