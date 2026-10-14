jest.mock('firebase-functions/v2/https', () => ({
  ...jest.requireActual('firebase-functions/v2/https'),
  onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
    typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler
  ),
}));

import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
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
    // Other emulator suites exercise partial/malformed release controls. Setup
    // callables require their own explicit valid admission fixture, not test order.
    await firestore.doc('_control/temporalProviderUsage').delete();
    await firestore.doc('_control/temporalRelease').set({
      schemaVersion: 1,
      revision: 1,
      releaseId: 'soundcloud-setup-test',
      updatedAt: Date.now(),
      admission: 'open',
      domains: { accounts: { owner: 'temporal', admission: 'open' } },
    });
  });

  afterAll(async () => {
    await firestore.doc('_control/temporalRelease').delete();
    await firestore.doc('_control/temporalProviderUsage').delete();
  });

  it('passes the auth metadata through for admins', async () => {
    const exchangeSpy = jest.spyOn(soundcloudSecretsModule, 'exchangeSoundCloudAuthorizationCode').mockResolvedValue({
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

    expect(exchangeSpy).toHaveBeenCalledWith(
      {
        ...data,
        connectedByUid: 'user-1',
        connectedByEmail: 'admin@example.com',
      },
      expect.any(Function),
      expect.objectContaining({ admissionLeaseId: expect.stringMatching(/^legacy-/) })
    );
  });

  it('rejects paused setup before session, lease or provider work', async () => {
    const control = firestore.doc('_control/temporalRelease');
    const beforeLeases = await firestore.collection('legacyAdmissionLeases').get();
    const operation = jest.spyOn(soundcloudSecretsModule, 'exchangeSoundCloudAuthorizationCode');
    await control.set({
      schemaVersion: 1,
      revision: 1,
      releaseId: 'paused-test',
      updatedAt: Date.now(),
      admission: 'paused',
      domains: { accounts: { owner: 'temporal', admission: 'paused' } },
    });
    try {
      await expect(
        handler({ auth: { uid: 'admin-1', token: { role: 'admin' } }, data: { code: 'code', state: 'state' } })
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(operation).not.toHaveBeenCalled();
      expect((await firestore.collection('legacyAdmissionLeases').get()).size).toBe(beforeLeases.size);
    } finally {
      await control.delete();
    }
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

  it('does not replay a one-time grant after an uncertain provider edge failure', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    const postSpy = jest.spyOn(axios, 'post').mockRejectedValue(
      Object.assign(new Error('edge block'), {
        isAxiosError: true,
        response: { status: 403, data: '<!DOCTYPE HTML><html>Request blocked</html>', headers: {} },
      })
    );
    const input = { code: 'one-time-code', state, connectedByUid: 'admin-1' };
    await expect(soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode(input)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode(input)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect((await pendingAuthSessionRef('admin-1').get()).get('exchangeStatus')).toBe('uncertain');
    // Fresh explicit consent creates a different code/state instead of replaying the uncertain grant.
    const fresh = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    expect(new URL(fresh.authorizeUrl).searchParams.get('state')).not.toBe(state);
  });

  it('atomically admits only one concurrent callback and prevents token refresh during its grant', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    let finish!: (value: unknown) => void;
    const waiting = new Promise((resolve) => {
      finish = resolve;
    });
    const postSpy = jest.spyOn(axios, 'post').mockImplementation(() => waiting as never);
    const input = { code: 'one-time-code', state, connectedByUid: 'admin-1' };
    const otherSession = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-2',
      redirectUri: TEST_REDIRECT_URI,
    });
    const first = soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode(input);
    for (let i = 0; i < 100 && postSpy.mock.calls.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postSpy).toHaveBeenCalledTimes(1);
    await expect(soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode(input)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(
      soundcloudSecretsModule.createSoundCloudAuthorizationSession({
        adminUid: 'admin-1',
        redirectUri: TEST_REDIRECT_URI,
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'other-code',
        state: new URL(otherSession.authorizeUrl).searchParams.get('state')!,
        connectedByUid: 'admin-2',
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    const refreshWaiting = soundcloudSecretsModule.getSoundCloudAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(postSpy).toHaveBeenCalledTimes(1);
    finish({ data: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } });
    await expect(first).resolves.toMatchObject({ connected: true });
    await expect(refreshWaiting).resolves.toBe('access');
    expect((await pendingAuthSessionRef('admin-1').get()).exists).toBe(false);
    expect((await soundCloudAuthStateRef.get()).get('oauthExchangeOwner')).toBeUndefined();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite credentials if the pending session changes after the provider consumed the grant', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    await soundCloudAuthStateRef.set(
      { accessToken: 'original-access', refreshToken: 'original-refresh' },
      { merge: true }
    );
    jest.spyOn(axios, 'post').mockImplementation(async () => {
      await pendingAuthSessionRef('admin-1').set({ state: 'replacement-intent' });
      return { data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } } as never;
    });
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({ code: 'code', state, connectedByUid: 'admin-1' })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await soundCloudAuthStateRef.get()).get('accessToken')).toBe('original-access');
    expect((await pendingAuthSessionRef('admin-1').get()).get('state')).toBe('replacement-intent');
  });

  it('allows fresh consent to fence an expired refresh owner while a live refresh blocks redemption', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    const server = (await soundCloudAuthStateRef.get()).readTime;
    await soundCloudAuthStateRef.set(
      {
        accessToken: 'valid-old',
        refreshToken: 'old-refresh',
        accessTokenExpiresAtMillis: server.toMillis() + 3600000,
        refreshLeaseOwner: 'crashed-refresh',
        refreshLeaseExpiresAtMillis: server.toMillis() - 1,
      },
      { merge: true }
    );
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    } as never);
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'new-code',
        state,
        connectedByUid: 'admin-1',
      })
    ).resolves.toMatchObject({ connected: true });
    expect((await soundCloudAuthStateRef.get()).get('refreshLeaseOwner')).toBeUndefined();
    const next = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    await soundCloudAuthStateRef.set(
      {
        refreshLeaseOwner: 'live-refresh',
        refreshLeaseExpiresAtMillis: (await soundCloudAuthStateRef.get()).readTime.toMillis() + 45000,
      },
      { merge: true }
    );
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'next-code',
        state: new URL(next.authorizeUrl).searchParams.get('state')!,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('fences a late expired refresh response after a fresh consent grant', async () => {
    await soundCloudAuthStateRef.set({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      accessTokenExpiresAtMillis: 1,
    });
    let finishRefresh!: (value: unknown) => void;
    const waiting = new Promise((resolve) => {
      finishRefresh = resolve;
    });
    const post = jest
      .spyOn(axios, 'post')
      .mockImplementationOnce(() => waiting as never)
      .mockResolvedValueOnce({
        data: { access_token: 'new-consent-access', refresh_token: 'new-consent-refresh', expires_in: 3600 },
      } as never);
    const oldRefresh = soundcloudSecretsModule.getSoundCloudAccessToken();
    for (let i = 0; i < 100 && post.mock.calls.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const server = (await soundCloudAuthStateRef.get()).readTime;
    await soundCloudAuthStateRef.update({ refreshLeaseExpiresAtMillis: server.toMillis() - 1 });
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'fresh-consent-code',
        state: new URL(session.authorizeUrl).searchParams.get('state')!,
        connectedByUid: 'admin-1',
      })
    ).resolves.toMatchObject({ connected: true });
    finishRefresh({
      data: { access_token: 'late-refresh-access', refresh_token: 'late-refresh-token', expires_in: 3600 },
    });
    await expect(oldRefresh).resolves.toBe('new-consent-access');
    expect((await soundCloudAuthStateRef.get()).data()).toMatchObject({
      accessToken: 'new-consent-access',
      refreshToken: 'new-consent-refresh',
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('requires explicit fresh consent to supersede an abandoned claim and fences its late provider response', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    let finish!: (value: unknown) => void;
    const waiting = new Promise((resolve) => {
      finish = resolve;
    });
    const post = jest.spyOn(axios, 'post').mockImplementation(() => waiting as never);
    // Exercise the real callable so the attempt is linked to an actual effects-started drain lease.
    const original = handler({ auth: { uid: 'admin-1', token: { role: 'admin' } }, data: { code: 'old-code', state } });
    for (let i = 0; i < 100 && post.mock.calls.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const owner = (await soundCloudAuthStateRef.get()).get('oauthExchangeOwner');
    const attemptRef = soundCloudAuthStateRef.collection('oauthAttempts').doc(owner);
    const attempt = await attemptRef.get();
    const leaseRef = firestore.collection('legacyAdmissionLeases').doc(attempt.get('admissionLeaseId'));
    expect((await leaseRef.get()).get('effectsStarted')).toBe(true);
    expect(attempt.get('claimedAt')).toBeInstanceOf(Timestamp);
    await expect(
      soundcloudSecretsModule.createSoundCloudAuthorizationSession({
        adminUid: 'admin-1',
        redirectUri: TEST_REDIRECT_URI,
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    // Fixture an abandoned server claim beyond the reviewed bound; production never alters its initial timestamp.
    const server = (await attemptRef.get()).readTime;
    const expiredClaim = new Timestamp(server.seconds - 121, server.nanoseconds);
    await attemptRef.update({
      claimedAt: expiredClaim,
      abandonedAfter: new Timestamp(expiredClaim.seconds + 120, expiredClaim.nanoseconds),
    });
    const leaseBefore = (await leaseRef.get()).data();
    const fresh = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    expect((await leaseRef.get()).data()).toEqual(leaseBefore);
    expect((await attemptRef.get()).data()).toMatchObject({
      status: 'superseded',
      outcome: 'unknown',
      admissionLeaseId: leaseRef.id,
      claimedAt: expiredClaim,
    });
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'old-code',
        state,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    finish({ data: { access_token: 'late-old-access', refresh_token: 'late-old-refresh', expires_in: 3600 } });
    await expect(original).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await soundCloudAuthStateRef.get()).get('accessToken')).toBeUndefined();
    expect((await pendingAuthSessionRef('admin-1').get()).get('state')).toBe(
      new URL(fresh.authorizeUrl).searchParams.get('state')
    );
    expect((await attemptRef.get()).get('status')).toBe('superseded');
    expect((await leaseRef.get()).data()).toMatchObject({ state: 'needs_attention', outcome: 'unknown' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('recovers failed claim cleanup through audited fresh consent without replaying the old grant', async () => {
    const session = await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    const state = new URL(session.authorizeUrl).searchParams.get('state')!;
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('Provider outcome unknown'));
    const realTransaction = firestore.runTransaction.bind(firestore);
    const transactions = jest
      .spyOn(firestore, 'runTransaction')
      .mockImplementationOnce(realTransaction)
      .mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'one-time',
        state,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    transactions.mockRestore();
    const owner = (await soundCloudAuthStateRef.get()).get('oauthExchangeOwner');
    const attemptRef = soundCloudAuthStateRef.collection('oauthAttempts').doc(owner);
    expect((await attemptRef.get()).get('status')).toBe('active');
    const server = (await attemptRef.get()).readTime;
    const claim = new Timestamp(server.seconds - 121, server.nanoseconds);
    await attemptRef.update({
      claimedAt: claim,
      abandonedAfter: new Timestamp(claim.seconds + 120, claim.nanoseconds),
    });
    await soundcloudSecretsModule.createSoundCloudAuthorizationSession({
      adminUid: 'admin-1',
      redirectUri: TEST_REDIRECT_URI,
    });
    expect((await attemptRef.get()).data()).toMatchObject({ status: 'superseded', outcome: 'unknown' });
    await expect(
      soundcloudSecretsModule.exchangeSoundCloudAuthorizationCode({
        code: 'one-time',
        state,
        connectedByUid: 'admin-1',
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('stores every rotated refresh token so the connection survives access-token expiry', async () => {
    await soundCloudAuthStateRef.set({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token-1',
      accessTokenExpiresAtMillis: Date.now() - 1,
    });
    const postSpy = jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: { access_token: 'access-token-2', refresh_token: 'refresh-token-2', expires_in: 3600 },
      } as never)
      .mockResolvedValueOnce({
        data: { access_token: 'access-token-3', refresh_token: 'refresh-token-3', expires_in: 3600 },
      } as never);

    await expect(soundcloudSecretsModule.getSoundCloudAccessToken()).resolves.toBe('access-token-2');
    expect((await soundCloudAuthStateRef.get()).data()?.refreshToken).toBe('refresh-token-2');

    await soundCloudAuthStateRef.set({ accessTokenExpiresAtMillis: Date.now() - 1 }, { merge: true });
    await expect(soundcloudSecretsModule.getSoundCloudAccessToken()).resolves.toBe('access-token-3');
    expect((await soundCloudAuthStateRef.get()).data()?.refreshToken).toBe('refresh-token-3');
    expect(new URLSearchParams(postSpy.mock.calls[0][1] as string).get('refresh_token')).toBe('refresh-token-1');
    expect(new URLSearchParams(postSpy.mock.calls[1][1] as string).get('refresh_token')).toBe('refresh-token-2');
  });

  it('shares one single-use refresh token exchange across concurrent callers', async () => {
    await soundCloudAuthStateRef.set({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token-1',
      accessTokenExpiresAtMillis: Date.now() - 1,
    });
    let finishExchange!: (value: unknown) => void;
    const pendingExchange = new Promise((resolve) => {
      finishExchange = resolve;
    });
    const postSpy = jest.spyOn(axios, 'post').mockImplementation(() => pendingExchange as never);

    const first = soundcloudSecretsModule.getSoundCloudAccessToken();
    for (let attempt = 0; postSpy.mock.calls.length === 0 && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(postSpy).toHaveBeenCalledTimes(1);
    const second = soundcloudSecretsModule.getSoundCloudAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postSpy).toHaveBeenCalledTimes(1);

    finishExchange({
      data: { access_token: 'access-token-2', refresh_token: 'refresh-token-2', expires_in: 3600 },
    });
    await expect(first).resolves.toBe('access-token-2');
    await expect(second).resolves.toBe('access-token-2');
    expect(postSpy).toHaveBeenCalledTimes(1);
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

  it('does not clear a newer pending session when the state mismatches', async () => {
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
    expect(pendingSession.exists).toBe(true);
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
