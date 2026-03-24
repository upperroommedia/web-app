jest.mock('firebase-functions/v2/https', () => ({
  ...jest.requireActual('firebase-functions/v2/https'),
  onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
    (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
  ),
}));

import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import exchangeSoundCloudAuthCode from '../../exchangeSoundCloudAuthCode';
import * as soundcloudSecretsModule from '../../soundcloudSecrets';
import type {
  ExchangeSoundCloudAuthCodeInput,
  ExchangeSoundCloudAuthCodeReturnType,
} from '../../exchangeSoundCloudAuthCode';

const SOUND_CLOUD_AUTH_STATE_COLLECTION = '_integrationAuth';
const SOUND_CLOUD_AUTH_STATE_DOC = 'soundcloud';
const SOUND_CLOUD_PENDING_AUTH_COLLECTION = 'pendingOAuthSessions';
const TEST_REDIRECT_URI = 'https://staging.uploader.upperroommedia.org/auth/soundcloud/callback';

const handler = exchangeSoundCloudAuthCode as unknown as (req: {
  auth?: { uid?: string; token?: { role?: string; email?: string } };
  data: ExchangeSoundCloudAuthCodeInput;
}) => Promise<ExchangeSoundCloudAuthCodeReturnType>;

const firestore = firebaseAdmin.firestore();
const soundCloudAuthStateRef = firestore.collection(SOUND_CLOUD_AUTH_STATE_COLLECTION).doc(SOUND_CLOUD_AUTH_STATE_DOC);
const pendingAuthSessionRef = (adminUid: string) =>
  soundCloudAuthStateRef.collection(SOUND_CLOUD_PENDING_AUTH_COLLECTION).doc(adminUid);

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

describe('exchangeSoundCloudAuthCode', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env.SOUNDCLOUD_CLIENT_ID = 'client-id';
    process.env.SOUNDCLOUD_CLIENT_SECRET = 'client-secret';
    delete process.env.SOUNDCLOUD_REFRESH_TOKEN;
    await clearSoundCloudAuthDocs();
  });

  it('passes the auth metadata through for admins', async () => {
    const exchangeSpy = jest
      .spyOn(soundcloudSecretsModule, 'exchangeSoundCloudAuthorizationCode')
      .mockResolvedValue({
        connected: true,
        connectedAtMillis: 123,
        accessTokenExpiresAtMillis: 456,
        connectedByEmail: 'admin@example.com',
      });

    const data: ExchangeSoundCloudAuthCodeInput = {
      code: 'soundcloud-code',
      state: 'oauth-state',
    };

    await expect(
      handler({
        auth: { uid: 'user-1', token: { role: 'admin', email: 'admin@example.com' } },
        data,
      })
    ).resolves.toMatchObject({
      connected: true,
      connectedByEmail: 'admin@example.com',
    });

    expect(exchangeSpy).toHaveBeenCalledWith({
      ...data,
      connectedByUid: 'user-1',
      connectedByEmail: 'admin@example.com',
    });
  });

  it('rejects non-admin callers', async () => {
    await expect(
      handler({
        auth: { uid: 'user-2', token: { role: 'publisher', email: 'publisher@example.com' } },
        data: {
          code: 'soundcloud-code',
          state: 'oauth-state',
        },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('exchanges the code using the stored PKCE verifier and consumes the pending session', async () => {
    const createSessionResult = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(createSessionResult.authorizeUrl).searchParams.get('state');
    if (!state) {
      throw new Error('Expected a persisted SoundCloud OAuth state');
    }

    const axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    } as any);

    const result = await soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
      code: 'soundcloud-code',
      state,
      connectedByUid: 'admin-1',
      connectedByEmail: 'admin@example.com',
    });

    expect(result.connected).toBe(true);
    expect(result.connectedByEmail).toBe('admin@example.com');
    expect(result.accessTokenExpiresAtMillis).toBeGreaterThan(Date.now());
    expect(axiosPostSpy).toHaveBeenCalledTimes(1);

    const [requestUrl, requestBody] = axiosPostSpy.mock.calls[0];
    expect(requestUrl).toBe('https://secure.soundcloud.com/oauth/token');
    const tokenPayload = new URLSearchParams(requestBody as string);
    const persistedSession = await pendingAuthSessionRef('admin-1').get();

    expect(tokenPayload.get('grant_type')).toBe('authorization_code');
    expect(tokenPayload.get('client_id')).toBe('client-id');
    expect(tokenPayload.get('client_secret')).toBe('client-secret');
    expect(tokenPayload.get('redirect_uri')).toBe(TEST_REDIRECT_URI);
    expect(tokenPayload.get('code')).toBe('soundcloud-code');
    expect(tokenPayload.get('code_verifier')).not.toBeNull();
    expect(persistedSession.exists).toBe(false);

    const authStateSnapshot = await soundCloudAuthStateRef.get();
    expect(authStateSnapshot.exists).toBe(true);
    expect(authStateSnapshot.data()).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      connectedByUid: 'admin-1',
      connectedByEmail: 'admin@example.com',
    });
  });

  it('fails when the pending session is missing', async () => {
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'soundcloud-code',
        state: 'missing-state',
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'The SoundCloud login session was not found. Start the flow again from Admin > Advanced.',
    });
  });

  it('fails and clears the pending session when the state mismatches', async () => {
    await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });

    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'soundcloud-code',
        state: 'wrong-state',
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message:
        'The SoundCloud OAuth state did not match the original request. Start the flow again from Admin > Advanced.',
    });

    const pendingSession = await pendingAuthSessionRef('admin-1').get();
    expect(pendingSession.exists).toBe(false);
  });

  it('fails and clears the pending session when it has expired', async () => {
    const createSessionResult = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(createSessionResult.authorizeUrl).searchParams.get('state');
    if (!state) {
      throw new Error('Expected a persisted SoundCloud OAuth state');
    }

    await pendingAuthSessionRef('admin-1').set(
      {
        expiresAtMillis: Date.now() - 1,
      },
      { merge: true }
    );

    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'soundcloud-code',
        state,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'The SoundCloud login session expired. Start the flow again from Admin > Advanced.',
    });

    const pendingSession = await pendingAuthSessionRef('admin-1').get();
    expect(pendingSession.exists).toBe(false);
  });

  it('cannot replay the same authorization state after the session has been consumed', async () => {
    const createSessionResult = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(createSessionResult.authorizeUrl).searchParams.get('state');
    if (!state) {
      throw new Error('Expected a persisted SoundCloud OAuth state');
    }

    const axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    } as any);

    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'soundcloud-code',
        state,
        connectedByUid: 'admin-1',
      })
    ).resolves.toMatchObject({ connected: true });

    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'soundcloud-code',
        state,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'The SoundCloud login session was not found. Start the flow again from Admin > Advanced.',
    });

    expect(axiosPostSpy).toHaveBeenCalledTimes(1);
  });
});
