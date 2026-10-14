import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';

let mockProjectId = 'urm-app-staging';
let mockDb: any;
let mockNow = Date.parse('2026-10-14T00:00:00Z');
let mockNativeReadTime = true;
const mockGetUser = jest.fn();
const mockLease = jest.fn();
const mockMarkEffects = jest.fn();
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: mockProjectId } }),
    firestore: () => mockDb,
    auth: () => ({ getUser: mockGetUser }),
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
jest.mock('../temporal/legacyAdmissionLease', () => ({
  withAdministrativeCredentialSetupLease: (...args: unknown[]) => mockLease(...args),
}));
import {
  getSandboxOAuthConfiguration,
  sandboxSoundCloudAuthDocumentPath,
  buildSandboxSoundCloudAuthorizeUrl,
  issueSandboxSoundCloudAuthorizationCode,
  exchangeSandboxSoundCloudToken,
  verifySandboxSoundCloudAccessToken,
  consentSoundCloudSandboxAuthorizationHandler,
  SANDBOX_SOUNDCLOUD_ORIGIN,
  SANDBOX_SOUNDCLOUD_USER_ID,
} from './oauth';
import { STAGING_SANDBOX_PROFILE, type SandboxProviderProfile } from './profile';
const profile = { ...STAGING_SANDBOX_PROFILE };
const state = 'S'.repeat(43),
  verifier = 'V'.repeat(86);
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = `${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/callback`;
const clone = (value: any): any =>
  value instanceof Timestamp
    ? new Timestamp(value.seconds, value.nanoseconds)
    : Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
    : value;
let records: Map<string, any>;
let writes: Array<[string, any]>;
let root: string;
const input = () => ({ adminUid: 'admin', state, redirectUri, codeChallenge });
function pending(patch = {}, uid = 'admin') {
  records.set(`${root}/pendingOAuthSessions/${uid}`, {
    state,
    codeVerifier: verifier,
    redirectUri,
    createdAtMillis: mockNow,
    expiresAtMillis: mockNow + 15 * 60_000,
    ...patch,
  });
}
const snapshot = (path: string) => ({
  exists: records.has(path),
  data: () => clone(records.get(path)),
  get: (field: string) => clone(records.get(path)?.[field]),
  readTime: mockNativeReadTime ? Timestamp.fromMillis(mockNow) : mockNow,
});
const doc = (path: string): any => ({
  path,
  get: async () => snapshot(path),
  collection: (name: string) => ({ doc: (id: string) => doc(`${path}/${name}/${id}`) }),
});
const payload = (code: string, patch = {}) =>
  new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: getSandboxOAuthConfiguration(profile).clientId,
    client_secret: getSandboxOAuthConfiguration(profile).clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    code,
    ...patch,
  });
const refreshPayload = (token: string) =>
  new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: getSandboxOAuthConfiguration(profile).clientId,
    client_secret: getSandboxOAuthConfiguration(profile).clientSecret,
    refresh_token: token,
  });
async function connect() {
  pending();
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  return { ...receipt, tokens: await exchangeSandboxSoundCloudToken(profile, payload(receipt.code)) };
}

beforeEach(() => {
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  mockProjectId = 'urm-app-staging';
  mockNow = Date.parse('2026-10-14T00:00:00Z');
  mockNativeReadTime = true;
  records = new Map();
  writes = [];
  let chain = Promise.resolve();
  mockDb = {
    doc,
    runTransaction: (callback: (tx: any) => Promise<unknown>) => {
      const result = chain.then(async () => {
        const staged: Array<[string, any]> = [];
        let wrote = false;
        const tx = {
          get: async (ref: any) => {
            expect(wrote).toBe(false);
            return snapshot(ref.path);
          },
          create: (ref: any, value: any) => {
            expect(records.has(ref.path)).toBe(false);
            wrote = true;
            staged.push([ref.path, clone(value)]);
          },
          update: (ref: any, value: any) => {
            expect(records.has(ref.path)).toBe(true);
            wrote = true;
            staged.push([ref.path, { ...clone(records.get(ref.path)), ...clone(value) }]);
          },
        };
        const value = await callback(tx);
        for (const [path, data] of staged) {
          records.set(path, data);
          writes.push([path, data]);
        }
        return value;
      });
      chain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
  root = sandboxSoundCloudAuthDocumentPath(profile);
  mockGetUser.mockReset().mockResolvedValue({ disabled: false, customClaims: { role: 'admin' } });
  mockMarkEffects.mockReset().mockResolvedValue(undefined);
  mockLease
    .mockReset()
    .mockImplementation(async (_db, _options, callback) => callback({ markEffectsStarted: mockMarkEffects }));
});
afterEach(() => {
  delete process.env.STAGING_PROVIDER_MODE;
  jest.restoreAllMocks();
});

test('configuration and auth cache are synthetic and strictly separate from real credentials', () => {
  process.env.SOUNDCLOUD_CLIENT_ID = 'REAL_CLIENT';
  process.env.SOUNDCLOUD_CLIENT_SECRET = 'REAL_SECRET';
  expect(getSandboxOAuthConfiguration(profile)).toEqual({
    clientId: 'urm-app-staging-sandbox-soundcloud',
    clientSecret: 'synthetic-stage-only-soundcloud-client-v1',
  });
  expect(root).toBe('_providerSandbox/urm-app-staging-publishing-v1/auth/soundcloud');
  expect(root).not.toContain('_integrationAuth');
  delete process.env.SOUNDCLOUD_CLIENT_ID;
  delete process.env.SOUNDCLOUD_CLIENT_SECRET;
});
test('same-origin consent URL carries the original state and S256 challenge only to the approved stage origin', () => {
  const url = new URL(
    buildSandboxSoundCloudAuthorizeUrl(profile, {
      ...input(),
      clientId: getSandboxOAuthConfiguration(profile).clientId,
    })
  );
  expect(url.origin + url.pathname).toBe(`${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/sandbox`);
  expect(url.searchParams.get('state')).toBe(state);
  expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
  expect(url.searchParams.get('code_challenge')).toBe(codeChallenge);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
});
test.each([
  'https://uploader.upperroommedia.org/auth/soundcloud/callback',
  'https://evil.invalid/auth/soundcloud/callback',
  redirectUri + '?next=evil',
  redirectUri + '#fragment',
  'http://staging.uploader.upperroommedia.org/auth/soundcloud/callback',
])('rejects redirect %s', (redirect) => {
  expect(() =>
    buildSandboxSoundCloudAuthorizeUrl(profile, {
      ...input(),
      redirectUri: redirect,
      clientId: getSandboxOAuthConfiguration(profile).clientId,
    })
  ).toThrow();
});
test('a complete consent, one-use code exchange and /me share the authoritative reserved synthetic account', async () => {
  const { tokens, code } = await connect();
  expect(await verifySandboxSoundCloudAccessToken(profile, tokens.access_token)).toEqual({
    id: SANDBOX_SOUNDCLOUD_USER_ID,
    urn: `soundcloud:users:${SANDBOX_SOUNDCLOUD_USER_ID}`,
  });
  expect(tokens.expires_in).toBe(3600);
  await expect(exchangeSandboxSoundCloudToken(profile, payload(code))).rejects.toThrow('Invalid or expired');
  expect(JSON.stringify([...records])).not.toContain(code);
  expect(JSON.stringify([...records])).not.toContain(tokens.access_token);
  expect(JSON.stringify([...records])).not.toContain(tokens.refresh_token);
  expect(writes.every(([path]) => path.startsWith(root + '/'))).toBe(true);
});
test('truthful optional actor/native-expiry fields added by the real pending-session writer are accepted', async () => {
  pending({ adminUid: 'admin', expiresAt: Timestamp.fromMillis(mockNow + 15 * 60_000) });
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  await expect(exchangeSandboxSoundCloudToken(profile, payload(receipt.code))).resolves.toHaveProperty('access_token');
});
test('same pending consent cannot issue a second authorization code', async () => {
  pending();
  await issueSandboxSoundCloudAuthorizationCode(profile, input());
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
});
test.each([
  { state: 'X'.repeat(43) },
  { redirectUri: redirectUri + '?other=1' },
  { codeVerifier: 'X'.repeat(86) },
  { adminUid: 'other' },
  { expiresAtMillis: 1 },
  { expiresAt: 1 },
  { exchangeAttempt: 'already-active' },
])('pending corruption is rejected before any code write: %j', async (patch) => {
  pending(patch);
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
  expect(writes).toHaveLength(0);
});
test('actor cannot borrow another administrator pending state', async () => {
  pending({}, 'other');
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
  expect(writes).toHaveLength(0);
});
test('native server read time controls pending and code expiry despite a skewed process clock', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(mockNow + 99 * 86400_000);
  pending();
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  mockNow += 5 * 60_000;
  await expect(exchangeSandboxSoundCloudToken(profile, payload(receipt.code))).rejects.toThrow();
});
test('non-native read timestamps cannot authorize issuance', async () => {
  pending();
  mockNativeReadTime = false;
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
  expect(writes).toHaveLength(0);
});
test.each([
  { code_verifier: 'X'.repeat(86) },
  { redirect_uri: redirectUri + '?other=1' },
  { client_id: 'real-client' },
  { client_secret: 'wrong' },
  { code: 'REAL_PROVIDER_CODE' },
])('incorrect code grant is not consumed: %j', async (patch) => {
  pending();
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  const before = writes.length;
  await expect(exchangeSandboxSoundCloudToken(profile, payload(receipt.code, patch))).rejects.toThrow();
  expect(writes).toHaveLength(before);
  await expect(exchangeSandboxSoundCloudToken(profile, payload(receipt.code))).resolves.toHaveProperty('access_token');
});
test('pending session replacement invalidates the already-issued original code', async () => {
  pending();
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  records.get(`${root}/pendingOAuthSessions/admin`).state = 'R'.repeat(43);
  await expect(exchangeSandboxSoundCloudToken(profile, payload(receipt.code))).rejects.toThrow();
});
test('ambiguous duplicate token grant parameters are rejected', async () => {
  pending();
  const receipt = await issueSandboxSoundCloudAuthorizationCode(profile, input());
  const params = payload(receipt.code);
  params.append('client_id', params.get('client_id')!);
  await expect(exchangeSandboxSoundCloudToken(profile, params)).rejects.toThrow();
});
test('refresh grant rotates once atomically, invalidates old access, and permits only one concurrent winner', async () => {
  const { tokens } = await connect();
  const results = await Promise.allSettled([
    exchangeSandboxSoundCloudToken(profile, refreshPayload(tokens.refresh_token)),
    exchangeSandboxSoundCloudToken(profile, refreshPayload(tokens.refresh_token)),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const rotated = (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<typeof tokens>)
    .value;
  await expect(verifySandboxSoundCloudAccessToken(profile, tokens.access_token)).rejects.toThrow();
  await expect(verifySandboxSoundCloudAccessToken(profile, rotated.access_token)).resolves.toHaveProperty(
    'id',
    SANDBOX_SOUNDCLOUD_USER_ID
  );
  await expect(exchangeSandboxSoundCloudToken(profile, refreshPayload(rotated.refresh_token))).resolves.toHaveProperty(
    'access_token'
  );
});
test('access expiry does not block valid refresh, while expired refresh cannot mint credentials', async () => {
  const { tokens } = await connect();
  mockNow += 3600_000;
  await expect(verifySandboxSoundCloudAccessToken(profile, tokens.access_token)).rejects.toThrow();
  const fresh = await exchangeSandboxSoundCloudToken(profile, refreshPayload(tokens.refresh_token));
  mockNow += 30 * 86400_000;
  await expect(exchangeSandboxSoundCloudToken(profile, refreshPayload(fresh.refresh_token))).rejects.toThrow();
});
test('profile spoofing, production, and missing sandbox selection reject before private writes', async () => {
  expect(() =>
    getSandboxOAuthConfiguration({ ...profile, namespace: 'other' } as unknown as SandboxProviderProfile)
  ).toThrow();
  mockProjectId = 'urm-app';
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
  mockProjectId = 'urm-app-staging';
  delete process.env.STAGING_PROVIDER_MODE;
  await expect(issueSandboxSoundCloudAuthorizationCode(profile, input())).rejects.toThrow();
  expect(writes).toHaveLength(0);
});
test('only hashed sandbox tokens can query /me; real/manual tokens never work', async () => {
  await expect(verifySandboxSoundCloudAccessToken(profile, 'REAL_PROVIDER_TOKEN')).rejects.toThrow();
  await expect(verifySandboxSoundCloudAccessToken(profile, 'sandbox-sc-access-' + 'X'.repeat(43))).rejects.toThrow();
});
const request = (role = 'admin', data: unknown = { state, redirectUri, codeChallenge }) =>
  ({ auth: { uid: 'admin', token: { role } }, data } as unknown as CallableRequest<any>);
test('consent callable derives actor from auth and marks the accounts credential lease before private writes', async () => {
  pending();
  mockMarkEffects.mockImplementation(async () => {
    expect(writes).toHaveLength(0);
  });
  const receipt = await consentSoundCloudSandboxAuthorizationHandler(request());
  expect(receipt.state).toBe(state);
  expect(receipt.redirectUri).toBe(redirectUri);
  expect(mockGetUser).toHaveBeenCalledWith('admin');
  expect(mockLease.mock.calls[0][1]).toEqual({
    actorUid: 'admin',
    actorRole: 'admin',
    operation: 'createSoundCloudAuthSession',
    projectId: 'urm-app-staging',
  });
  expect(mockMarkEffects).toHaveBeenCalledTimes(1);
});
test('consent callable rejects non-admin, stale admin, disabled, caller actor injection, and blocked lease', async () => {
  pending();
  await expect(consentSoundCloudSandboxAuthorizationHandler(request('uploader'))).rejects.toThrow('Only admins');
  mockGetUser.mockResolvedValueOnce({ customClaims: { role: 'uploader' } });
  await expect(consentSoundCloudSandboxAuthorizationHandler(request())).rejects.toThrow('Only admins');
  mockGetUser.mockResolvedValueOnce({ disabled: true, customClaims: { role: 'admin' } });
  await expect(consentSoundCloudSandboxAuthorizationHandler(request())).rejects.toThrow('Only admins');
  await expect(
    consentSoundCloudSandboxAuthorizationHandler(
      request('admin', { state, redirectUri, codeChallenge, adminUid: 'victim' })
    )
  ).rejects.toThrow('Invalid sandbox consent');
  mockLease.mockRejectedValueOnce(new Error('admission paused'));
  await expect(consentSoundCloudSandboxAuthorizationHandler(request())).rejects.toThrow('admission paused');
  expect(writes).toHaveLength(0);
});
