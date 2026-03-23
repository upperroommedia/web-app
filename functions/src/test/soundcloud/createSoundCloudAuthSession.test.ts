import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

import createSoundCloudAuthSession from '../../createSoundCloudAuthSession';
import * as soundcloudSecretsModule from '../../soundcloudSecrets';
import type {
  CreateSoundCloudAuthSessionInput,
  CreateSoundCloudAuthSessionReturnType,
} from '../../createSoundCloudAuthSession';

const SOUND_CLOUD_AUTH_STATE_COLLECTION = '_integrationAuth';
const SOUND_CLOUD_AUTH_STATE_DOC = 'soundcloud';
const SOUND_CLOUD_PENDING_AUTH_COLLECTION = 'pendingOAuthSessions';
const TEST_REDIRECT_URI = 'https://staging.uploader.upperroommedia.org/auth/soundcloud/callback';

type CreateSoundCloudAuthSessionRequest = {
  auth?: { uid?: string; token?: { role?: string } };
  data: CreateSoundCloudAuthSessionInput;
};

const handler = createSoundCloudAuthSession as unknown as (
  request: CreateSoundCloudAuthSessionRequest
) => Promise<CreateSoundCloudAuthSessionReturnType>;

const firestore = firebaseAdmin.firestore();
const soundCloudAuthStateRef = firestore.collection(SOUND_CLOUD_AUTH_STATE_COLLECTION).doc(SOUND_CLOUD_AUTH_STATE_DOC);
const pendingAuthSessionRef = (adminUid: string) =>
  soundCloudAuthStateRef.collection(SOUND_CLOUD_PENDING_AUTH_COLLECTION).doc(adminUid);

const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const buildCodeChallenge = (codeVerifier: string): string =>
  toBase64Url(createHash('sha256').update(codeVerifier).digest());

const clearSoundCloudAuthDocs = async (): Promise<void> => {
  const pendingSnapshot = await soundCloudAuthStateRef.collection(SOUND_CLOUD_PENDING_AUTH_COLLECTION).get();
  if (!pendingSnapshot.empty) {
    const batch = firestore.batch();
    pendingSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  }

  await soundCloudAuthStateRef.delete().catch(() => undefined);
};

describe('createSoundCloudAuthSession', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env.SOUNDCLOUD_CLIENT_ID = 'client-id';
    process.env.SOUNDCLOUD_CLIENT_SECRET = 'client-secret';
    delete process.env.SOUNDCLOUD_REFRESH_TOKEN;
    await clearSoundCloudAuthDocs();
  });

  it('passes the admin uid and redirect URI through the callable wrapper', async () => {
    const createSessionSpy = jest
      .spyOn(soundcloudSecretsModule, 'createSoundCloudAuthorizationSession')
      .mockResolvedValue({
        authorizeUrl: 'https://secure.soundcloud.com/authorize?state=test-state',
        expiresAtMillis: 123,
      });

    await expect(
      handler({
        auth: { uid: 'admin-1', token: { role: 'admin' } },
        data: { redirectUri: TEST_REDIRECT_URI },
      })
    ).resolves.toEqual({
      authorizeUrl: 'https://secure.soundcloud.com/authorize?state=test-state',
      expiresAtMillis: 123,
    });

    expect(createSessionSpy).toHaveBeenCalledWith({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
  });

  it('rejects non-admin callers', async () => {
    await expect(
      handler({
        auth: { uid: 'publisher-1', token: { role: 'publisher' } },
        data: { redirectUri: TEST_REDIRECT_URI },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('creates a PKCE-backed authorize URL and persists a pending session server-side', async () => {
    const beforeCreateMillis = Date.now();
    const result = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const afterCreateMillis = Date.now();

    expect(result.expiresAtMillis).toBeGreaterThan(beforeCreateMillis);

    const authorizeUrl = new URL(result.authorizeUrl);
    expect(authorizeUrl.origin).toBe('https://secure.soundcloud.com');
    expect(authorizeUrl.pathname).toBe('/authorize');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('client-id');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const persistedSession = await pendingAuthSessionRef('admin-1').get();
    expect(persistedSession.exists).toBe(true);

    const persistedData = persistedSession.data();
    expect(persistedData).toMatchObject({
      redirectUri: TEST_REDIRECT_URI,
    });
    expect(typeof persistedData?.state).toBe('string');
    expect(typeof persistedData?.codeVerifier).toBe('string');
    expect(typeof persistedData?.createdAtMillis).toBe('number');
    expect(typeof persistedData?.expiresAtMillis).toBe('number');

    expect(authorizeUrl.searchParams.get('state')).toBe(persistedData?.state);
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe(buildCodeChallenge(persistedData?.codeVerifier));
    expect(persistedData?.createdAtMillis).toBeGreaterThanOrEqual(beforeCreateMillis);
    expect(persistedData?.createdAtMillis).toBeLessThanOrEqual(afterCreateMillis);
    expect(persistedData?.expiresAtMillis).toBe(result.expiresAtMillis);
  });
});
