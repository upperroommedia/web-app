import { Timestamp } from 'firebase-admin/firestore';

let mockProject = 'urm-app-staging';
let mockAllowProduction = false;
let mockDb: any;
let mockRecords: Map<string, any>;
const mockSecretRead = jest.fn();
const mockWire = jest.fn();
const mockRtdb = jest.fn();
const mockRtdbRef = jest.fn();
const mockPaths: string[] = [];
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: mockProject } }),
    firestore: () => mockDb,
    database: () => mockRtdb(),
  },
}));
jest.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ name, value: () => mockSecretRead(name) }),
}));
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  },
  onCall: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../sentry', () => ({ functionsSentryDsnSecret: { value: () => mockSecretRead('FUNCTIONS_SENTRY_DSN') } }));
jest.mock('../notifications/notificationSecrets', () => ({
  runtimeAlertRecipientsSecret: { value: () => mockSecretRead('RUNTIME_ALERT_RECIPIENTS') },
}));
jest.mock('../providerRelay', () => ({
  providerEgressRelayTokenSecret: { value: () => mockSecretRead('PROVIDER_EGRESS_RELAY_TOKEN') },
}));
jest.mock('../temporal/legacyAdmissionLease', () => ({
  withAdministrativeCredentialSetupLease: () => {
    throw new Error('UNEXPECTED_CONSENT_LEASE');
  },
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => undefined,
  getPublishingSourceStepIds: () => undefined,
}));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const wire = (...args: unknown[]) => mockWire(...args);
  return {
    ...actual,
    __esModule: true,
    default: Object.assign(jest.fn(wire), actual.default, {
      request: wire,
      get: wire,
      post: wire,
      put: wire,
      patch: wire,
      delete: wire,
      head: wire,
      options: wire,
      postForm: wire,
      putForm: wire,
      patchForm: wire,
      create: wire,
    }),
  };
});
import { getSoundCloudAuthStatus, createSoundCloudAuthorizationSession } from '../soundcloudSecrets';
import { authenticateSubsplash } from '../subsplashUtils';
import { STAGING_SANDBOX_PROFILE } from './profile';
import { getSandboxOAuthConfiguration, sandboxSoundCloudAuthDocumentPath, SANDBOX_SOUNDCLOUD_ORIGIN } from './oauth';

const originalEnv = process.env;
const guardedNames = new Set([
  'SOUNDCLOUD_CLIENT_ID',
  'SOUNDCLOUD_CLIENT_SECRET',
  'SOUNDCLOUD_REFRESH_TOKEN',
  'SUBSPLASH_EMAIL',
  'SUBSPLASH_PASSWORD',
]);
const mockEnvReads: string[] = [];
const now = Date.parse('2026-10-14T00:00:00Z');
const clone = (value: any): any =>
  value instanceof Timestamp
    ? new Timestamp(value.seconds, value.nanoseconds)
    : Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
    : value;
function reference(path: string): any {
  mockPaths.push(path);
  if (!mockAllowProduction && !path.startsWith('_providerSandbox/urm-app-staging-publishing-v1/'))
    throw new Error('REAL_AUTH_DOCUMENT_FORBIDDEN');
  return {
    path,
    collection: (name: string) => ({ doc: (id: string) => reference(`${path}/${name}/${id}`) }),
    get: async () => snapshot(path),
  };
}
const snapshot = (path: string) => ({
  ref: reference(path),
  exists: mockRecords.has(path),
  data: () => clone(mockRecords.get(path)),
  get: (field: string) => clone(mockRecords.get(path)?.[field]),
  readTime: Timestamp.fromMillis(now),
});
beforeEach(() => {
  mockProject = 'urm-app-staging';
  mockAllowProduction = false;
  mockPaths.length = 0;
  mockEnvReads.length = 0;
  mockRecords = new Map();
  const environment = {
    ...originalEnv,
    STAGING_PROVIDER_MODE: 'sandbox',
    SOUNDCLOUD_CLIENT_ID: 'ENV_REAL_CLIENT',
    SOUNDCLOUD_CLIENT_SECRET: 'ENV_REAL_SECRET',
    SOUNDCLOUD_REFRESH_TOKEN: 'ENV_REAL_REFRESH',
    SUBSPLASH_EMAIL: 'real-account@example.invalid',
    SUBSPLASH_PASSWORD: 'ENV_REAL_PASSWORD',
  };
  process.env = new Proxy(environment, {
    get(target, key) {
      if (typeof key === 'string' && guardedNames.has(key)) {
        mockEnvReads.push(key);
        if (!mockAllowProduction) throw new Error('REAL_CREDENTIAL_ENV_READ_FORBIDDEN');
      }
      return Reflect.get(target, key);
    },
  });
  mockSecretRead.mockReset().mockImplementation((name: string) => {
    if (!mockAllowProduction) throw new Error('REAL_SECRET_READ_FORBIDDEN');
    return name === 'SOUNDCLOUD_CLIENT_ID'
      ? 'PRODUCTION_CLIENT_ID'
      : name === 'SOUNDCLOUD_CLIENT_SECRET'
      ? 'PRODUCTION_CLIENT_SECRET'
      : '';
  });
  mockWire.mockReset().mockImplementation(() => {
    throw new Error('RAW_AXIOS_NETWORK_FORBIDDEN');
  });
  mockRtdbRef.mockReset().mockImplementation(() => {
    throw new Error('REAL_RTDB_CACHE_FORBIDDEN');
  });
  mockRtdb.mockReset().mockImplementation(() => {
    if (!mockAllowProduction) throw new Error('REAL_RTDB_FORBIDDEN');
    return { ref: mockRtdbRef };
  });
  mockDb = {
    doc: reference,
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async (work: (tx: any) => Promise<unknown>) => {
      const writes: Array<[string, any]> = [];
      let wrote = false;
      const value = await work({
        get: async (ref: any) => {
          expect(wrote).toBe(false);
          return snapshot(ref.path);
        },
        set: (ref: any, data: any, options?: { merge?: boolean }) => {
          wrote = true;
          writes.push([ref.path, { ...(options?.merge ? clone(mockRecords.get(ref.path)) : {}), ...clone(data) }]);
        },
        update: (ref: any, data: any) => {
          wrote = true;
          writes.push([ref.path, { ...clone(mockRecords.get(ref.path)), ...clone(data) }]);
        },
      });
      for (const [path, data] of writes) mockRecords.set(path, data);
      return value;
    },
  };
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NATIVE_NETWORK_FORBIDDEN'));
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});
function assertNoLiveAccess() {
  expect(mockSecretRead).not.toHaveBeenCalled();
  expect(mockEnvReads).toEqual([]);
  expect(mockRtdb).not.toHaveBeenCalled();
  expect(mockWire).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockPaths.every((path) => path.startsWith('_providerSandbox/urm-app-staging-publishing-v1/'))).toBe(true);
}

test('actual SoundCloud status selects synthetic configuration and only the separate private sandbox cache before live secrets/env', async () => {
  const status = await getSoundCloudAuthStatus();
  expect(status).toMatchObject({
    configured: true,
    connected: false,
    tokenSource: 'none',
    clientId: getSandboxOAuthConfiguration(STAGING_SANDBOX_PROFILE).clientId,
  });
  expect(mockPaths).toContain(sandboxSoundCloudAuthDocumentPath(STAGING_SANDBOX_PROFILE));
  assertNoLiveAccess();
});
test('actual SoundCloud status recognizes only its private sandbox connection', async () => {
  mockRecords.set(sandboxSoundCloudAuthDocumentPath(STAGING_SANDBOX_PROFILE), {
    refreshToken: 'sandbox-private-refresh',
    connectedByEmail: 'stage-admin@example.invalid',
    connectedAtMillis: now,
  });
  const status = await getSoundCloudAuthStatus();
  expect(status).toMatchObject({
    connected: true,
    configured: true,
    tokenSource: 'firestore',
    connectedByEmail: 'stage-admin@example.invalid',
  });
  assertNoLiveAccess();
});
test('actual authorization session uses synthetic client and approved stage consent with original private PKCE pending state', async () => {
  const beforeEffects = jest.fn(async () => {
    expect(mockRecords.size).toBe(0);
  });
  const receipt = await createSoundCloudAuthorizationSession(
    { adminUid: 'stage-admin', redirectUri: `${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/callback` },
    beforeEffects
  );
  const url = new URL(receipt.authorizeUrl);
  expect(url.origin + url.pathname).toBe(`${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/sandbox`);
  expect(url.searchParams.get('client_id')).toBe(getSandboxOAuthConfiguration(STAGING_SANDBOX_PROFILE).clientId);
  const pendingPath = `${sandboxSoundCloudAuthDocumentPath(STAGING_SANDBOX_PROFILE)}/pendingOAuthSessions/stage-admin`;
  const pending = mockRecords.get(pendingPath);
  expect(pending.state).toBe(url.searchParams.get('state'));
  expect(pending.redirectUri).toBe(url.searchParams.get('redirect_uri'));
  expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(pending.expiresAtMillis).toBe(receipt.expiresAtMillis);
  expect(beforeEffects).toHaveBeenCalledTimes(1);
  expect([...mockRecords.keys()]).toEqual([pendingPath]);
  assertNoLiveAccess();
});
test('actual Subsplash authentication returns a stage token without RTDB, credentials or transport access', async () => {
  await expect(authenticateSubsplash()).resolves.toBe('provider-sandbox:urm-app-staging-publishing-v1:subsplash');
  assertNoLiveAccess();
});
test('stage selection precedes an already-populated production in-memory Subsplash cache', async () => {
  mockProject = 'urm-app';
  mockAllowProduction = true;
  delete process.env.STAGING_PROVIDER_MODE;
  mockRtdbRef.mockImplementation((path: string) => {
    expect(path).toBe('subsplashAuthSession/cache');
    return {
      get: async () => ({
        val: () => ({ accessToken: 'PRODUCTION_MEMORY_TOKEN', expiresAtMs: now + 3600_000, refreshedAtMs: now }),
      }),
    };
  });
  await expect(authenticateSubsplash()).resolves.toBe('PRODUCTION_MEMORY_TOKEN');
  expect(mockRtdb).toHaveBeenCalled();
  mockProject = 'urm-app-staging';
  mockAllowProduction = false;
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  mockRtdb.mockClear();
  mockSecretRead.mockClear();
  mockEnvReads.length = 0;
  await expect(authenticateSubsplash()).resolves.toBe('provider-sandbox:urm-app-staging-publishing-v1:subsplash');
  assertNoLiveAccess();
});
for (const entrypoint of [
  getSoundCloudAuthStatus,
  () =>
    createSoundCloudAuthorizationSession({
      adminUid: 'stage-admin',
      redirectUri: `${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/callback`,
    }),
  authenticateSubsplash,
]) {
  test(`${entrypoint.name || 'authorization-session'} fails closed when staging mode is absent`, async () => {
    delete process.env.STAGING_PROVIDER_MODE;
    await expect(entrypoint()).rejects.toThrow('PROVIDER_PROFILE_NOT_CONFIGURED');
    assertNoLiveAccess();
  });
  test(`${
    entrypoint.name || 'authorization-session'
  } rejects an actual project mismatch despite claimed staging environment`, async () => {
    mockProject = 'foreign-project';
    process.env.FIREBASE_PROJECT_ID = 'urm-app-staging';
    await expect(entrypoint()).rejects.toThrow('PROVIDER_PROFILE_NOT_CONFIGURED');
    assertNoLiveAccess();
  });
}
test('actual production SoundCloud flow preserves real configuration, cache and provider authorization URL behavior under explicit mocked transport', async () => {
  mockProject = 'urm-app';
  mockAllowProduction = true;
  delete process.env.STAGING_PROVIDER_MODE;
  mockRecords.set('_integrationAuth/soundcloud', { refreshToken: 'PRODUCTION_REFRESH', connectedAtMillis: now });
  const status = await getSoundCloudAuthStatus();
  expect(status).toMatchObject({
    clientId: 'PRODUCTION_CLIENT_ID',
    configured: true,
    connected: true,
    tokenSource: 'firestore',
  });
  const receipt = await createSoundCloudAuthorizationSession({
    adminUid: 'production-admin',
    redirectUri: 'https://uploader.upperroommedia.org/auth/soundcloud/callback',
  });
  const url = new URL(receipt.authorizeUrl);
  expect(url.origin + url.pathname).toBe('https://secure.soundcloud.com/authorize');
  expect(url.searchParams.get('client_id')).toBe('PRODUCTION_CLIENT_ID');
  expect(mockRecords.has('_integrationAuth/soundcloud/pendingOAuthSessions/production-admin')).toBe(true);
  expect(mockSecretRead).toHaveBeenCalledWith('SOUNDCLOUD_CLIENT_ID');
  expect(mockSecretRead).toHaveBeenCalledWith('SOUNDCLOUD_CLIENT_SECRET');
  expect(mockWire).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
