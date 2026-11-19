/**
 * SoundCloud OAuth token management for Firebase callable functions.
 *
 * SoundCloud's documented OAuth flow issues short-lived access tokens and
 * refresh tokens that can mint fresh access tokens without another user login.
 * After the initial admin consent flow, we persist the refresh token in
 * Firestore and refresh access tokens automatically for publish/edit/delete.
 */
import axios from './providerSandbox/http';
import { isAxiosError } from 'axios';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';
import { functionsSentryDsnSecret } from './sentry';
import { createSoundCloudReconnectRequiredError, isSoundCloudReconnectRequiredError } from './soundcloudAuthErrors';
import { getAuthenticatedSoundCloudAccountId } from './soundcloudClient';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { getHtmlEdgeBlock } from './helpers/upstreamHttpErrors';
import { providerEgressRelayTokenSecret } from './providerRelay';
import { currentSandboxProfile } from './providerSandbox/http';
import {
  getSandboxOAuthConfiguration,
  sandboxSoundCloudAuthDocumentPath,
  buildSandboxSoundCloudAuthorizeUrl,
} from './providerSandbox/oauth';

const SOUND_CLOUD_TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const SOUND_CLOUD_AUTH_STATE_COLLECTION = '_integrationAuth';
const SOUND_CLOUD_AUTH_STATE_DOC = 'soundcloud';
const SOUND_CLOUD_PENDING_AUTH_COLLECTION = 'pendingOAuthSessions';
const SOUND_CLOUD_CALLBACK_PATH = '/auth/soundcloud/callback';
const PENDING_SOUND_CLOUD_AUTH_TTL_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_LEASE_MS = 45 * 1000;
const REFRESH_WAIT_MS = 750;
const MAX_REFRESH_WAIT_ATTEMPTS = 60;
// OAuth callables have an explicit 60s runtime limit. Only new explicit consent
// may supersede a claim after twice that bound; expiry never proves no effect.
const OAUTH_ABANDONED_AFTER_SECONDS = 120;
type OAuthAdmission = { admissionLeaseId: string };
const oauthAttemptRef = (attempt: string) => soundcloudAuthStateRef().collection('oauthAttempts').doc(attempt);
const nativeTimeReached = (now: Timestamp, deadline: Timestamp): boolean =>
  now.seconds > deadline.seconds || (now.seconds === deadline.seconds && now.nanoseconds >= deadline.nanoseconds);

export type SoundCloudAuthState = {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAtMillis?: number;
  connectedAtMillis?: number;
  connectedByUid?: string;
  connectedByEmail?: string;
  accountId?: string;
  refreshRecovery?: 'invalid_grant' | 'outcome_unknown';
  refreshLeaseOwner?: string;
  refreshLeaseExpiresAtMillis?: number;
  updatedAtMillis?: number;
  oauthExchangeOwner?: string;
};

type RefreshGrantResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

export type SoundCloudAuthStatus = {
  clientId: string | null;
  callbackPath: string;
  connected: boolean;
  configured: boolean;
  reconnectRequired?: true;
  accountId?: string;
  tokenSource: 'firestore' | 'secret' | 'none';
  accessTokenExpiresAtMillis?: number;
  connectedAtMillis?: number;
  connectedByEmail?: string;
  updatedAtMillis?: number;
};

export type ExchangeSoundCloudAuthorizationCodeInput = {
  code: string;
  state: string;
  connectedByUid?: string;
  connectedByEmail?: string;
};

export type ExchangeSoundCloudAuthorizationCodeResult = {
  connected: true;
  accessTokenExpiresAtMillis: number;
  connectedAtMillis: number;
  connectedByEmail?: string;
};

type PendingSoundCloudAuthorizationSession = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAtMillis: number;
  expiresAtMillis: number;
  exchangeAttempt?: string;
  exchangeStatus?: 'active' | 'uncertain';
};

export type CreateSoundCloudAuthorizationSessionInput = {
  adminUid: string;
  redirectUri: string;
};

export type CreateSoundCloudAuthorizationSessionResult = {
  authorizeUrl: string;
  expiresAtMillis: number;
};

const soundcloudClientIdSecret = defineSecret('SOUNDCLOUD_CLIENT_ID');
const soundcloudClientSecretSecret = defineSecret('SOUNDCLOUD_CLIENT_SECRET');

const soundcloudAuthStateRef = () => {
  const profile = currentSandboxProfile();
  return profile
    ? firebaseAdmin.firestore().doc(sandboxSoundCloudAuthDocumentPath(profile))
    : firebaseAdmin.firestore().collection(SOUND_CLOUD_AUTH_STATE_COLLECTION).doc(SOUND_CLOUD_AUTH_STATE_DOC);
};

const soundcloudPendingAuthSessionRef = (adminUid: string) =>
  soundcloudAuthStateRef().collection(SOUND_CLOUD_PENDING_AUTH_COLLECTION).doc(adminUid);

const readConfiguredValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const getConfiguredClientId = (): string | null => {
  const profile = currentSandboxProfile();
  return profile
    ? getSandboxOAuthConfiguration(profile).clientId
    : readConfiguredValue(soundcloudClientIdSecret.value()) ?? readConfiguredValue(process.env.SOUNDCLOUD_CLIENT_ID);
};

const getConfiguredClientSecret = (): string | null => {
  const profile = currentSandboxProfile();
  return profile
    ? getSandboxOAuthConfiguration(profile).clientSecret
    : readConfiguredValue(soundcloudClientSecretSecret.value()) ??
        readConfiguredValue(process.env.SOUNDCLOUD_CLIENT_SECRET);
};

const getBootstrapRefreshToken = (): string | null =>
  currentSandboxProfile() ? null : readConfiguredValue(process.env.SOUNDCLOUD_REFRESH_TOKEN);

const nowMillis = (): number => Date.now();

const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const createPkcePair = (): { codeVerifier: string; codeChallenge: string } => {
  const codeVerifier = toBase64Url(randomBytes(64));
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
};

const createOAuthState = (): string => toBase64Url(randomBytes(32));

const isAccessTokenFresh = (
  state: SoundCloudAuthState | null,
  currentTimeMillis: number
): state is SoundCloudAuthState => {
  return Boolean(
    state?.accessToken &&
      state.accessTokenExpiresAtMillis &&
      state.accessTokenExpiresAtMillis - ACCESS_TOKEN_REFRESH_BUFFER_MS > currentTimeMillis
  );
};

const sleep = async (durationMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const getSoundCloudSetupError = (): HttpsError =>
  createSoundCloudReconnectRequiredError(
    'SoundCloud OAuth is not configured. Set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET, then connect SoundCloud from Admin > Advanced.'
  );

const getSoundCloudNotConnectedError = (): HttpsError =>
  createSoundCloudReconnectRequiredError(
    'SoundCloud is not connected. Open Admin > Advanced and complete the SoundCloud authorization flow.'
  );

const normalizeRedirectUri = (redirectUri: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new HttpsError('invalid-argument', 'The SoundCloud redirect URI must be a valid absolute URL.');
  }

  if (parsed.pathname !== SOUND_CLOUD_CALLBACK_PATH) {
    throw new HttpsError(
      'invalid-argument',
      `The SoundCloud redirect URI must use the ${SOUND_CLOUD_CALLBACK_PATH} callback path.`
    );
  }

  parsed.hash = '';
  return parsed.toString();
};

const readAuthState = async (): Promise<SoundCloudAuthState | null> => {
  const snapshot = await soundcloudAuthStateRef().get();
  if (!snapshot.exists) {
    return null;
  }
  return snapshot.data() as SoundCloudAuthState;
};

const deletePendingSoundCloudAuthorizationSession = async (adminUid: string, state: string): Promise<void> => {
  const pendingSessionRef = soundcloudPendingAuthSessionRef(adminUid);
  await firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(pendingSessionRef);
    if (snapshot.exists && snapshot.data()?.state === state) {
      transaction.delete(pendingSessionRef);
    }
  });
};

const readPendingSoundCloudAuthorizationSession = async (
  adminUid: string,
  state: string,
  beforeEffects: () => Promise<void>
): Promise<PendingSoundCloudAuthorizationSession> => {
  const currentTimeMillis = nowMillis();
  const pendingSessionRef = soundcloudPendingAuthSessionRef(adminUid);
  const snapshot = await pendingSessionRef.get();
  if (!snapshot.exists) {
    throw new HttpsError(
      'failed-precondition',
      'The SoundCloud login session was not found. Start the flow again from Admin > Advanced.'
    );
  }

  const pendingSession = snapshot.data() as PendingSoundCloudAuthorizationSession | undefined;
  const hasRequiredFields = Boolean(
    pendingSession?.state &&
      pendingSession.codeVerifier &&
      pendingSession.redirectUri &&
      typeof pendingSession.createdAtMillis === 'number' &&
      typeof pendingSession.expiresAtMillis === 'number'
  );

  if (!hasRequiredFields) {
    throw new HttpsError(
      'failed-precondition',
      'The SoundCloud login session was invalid. Start the flow again from Admin > Advanced.'
    );
  }

  const validatedPendingSession = pendingSession as PendingSoundCloudAuthorizationSession;

  if (validatedPendingSession.expiresAtMillis <= currentTimeMillis) {
    await beforeEffects();
    await deletePendingSoundCloudAuthorizationSession(adminUid, state);
    throw new HttpsError(
      'failed-precondition',
      'The SoundCloud login session expired. Start the flow again from Admin > Advanced.'
    );
  }

  if (validatedPendingSession.state !== state) {
    throw new HttpsError(
      'failed-precondition',
      'The SoundCloud OAuth state did not match the original request. Start the flow again from Admin > Advanced.'
    );
  }

  return validatedPendingSession;
};

const createTokenPayload = (pairs: Record<string, string>): URLSearchParams => {
  const payload = new URLSearchParams();
  Object.entries(pairs).forEach(([key, value]) => {
    payload.set(key, value);
  });
  return payload;
};

const postSoundCloudTokenGrant = async (
  payload: URLSearchParams,
  invalidGrantMessage: string,
  refreshing = false
): Promise<Required<RefreshGrantResponse>> => {
  try {
    const response = await axios.post<RefreshGrantResponse>(SOUND_CLOUD_TOKEN_URL, payload.toString(), {
      timeout: 8_000,
      headers: {
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const accessToken = readConfiguredValue(response.data?.access_token);
    const refreshToken = readConfiguredValue(response.data?.refresh_token);
    const expiresIn = response.data?.expires_in;

    if (
      !accessToken ||
      !refreshToken ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new Error('SoundCloud token exchange response was missing access_token, refresh_token, or expires_in.');
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
    };
  } catch (error) {
    if (isAxiosError(error)) {
      const soundCloudError = error.response?.data;
      const status = error.response?.status;

      const edgeBlock = getHtmlEdgeBlock(error);
      if (edgeBlock) {
        logger.error('SoundCloud token request was blocked by its edge network', {
          status,
          soundCloudRequestId: edgeBlock.requestId,
          soundCloudEdgePop: error.response?.headers?.['x-amz-cf-pop'],
        });
        throw new HttpsError(
          'unavailable',
          'SoundCloud is temporarily blocking the connection from our server. Please try again later. If this continues, contact support.'
        );
      }

      const errorCode = soundCloudError?.error;
      if (
        (!refreshing && (status === 400 || status === 401)) ||
        ((status === 400 || status === 401) && (errorCode === 'invalid_grant' || error.code === 'invalid_grant'))
      ) {
        logger.warn('SoundCloud token grant was rejected', { status, invalidGrant: errorCode === 'invalid_grant' });
        throw createSoundCloudReconnectRequiredError(invalidGrantMessage);
      }

      // A known pre-grant rejection can be retried without consuming the refresh token.
      if (status === 429 || ((status === 400 || status === 401) && errorCode === 'invalid_client')) {
        throw new HttpsError(
          'unavailable',
          'SoundCloud authorization is temporarily unavailable. Please try again later.'
        );
      }

      logger.error('SoundCloud token exchange failed', { status });
      throw new HttpsError('internal', 'SoundCloud token exchange failed unexpectedly.');
    }

    throw error;
  }
};

class SoundCloudAccountMismatch extends Error {}

const writeTokenState = async (
  tokens: Required<RefreshGrantResponse>,
  options: {
    connectedAtMillis?: number;
    connectedByUid?: string;
    connectedByEmail?: string;
    state: string;
    exchangeAttempt: string;
    accountId: string;
  }
): Promise<ExchangeSoundCloudAuthorizationCodeResult> => {
  const updatedAtMillis = nowMillis();
  const accessTokenExpiresAtMillis = updatedAtMillis + tokens.expires_in * 1000;
  const connectedAtMillis = options?.connectedAtMillis ?? updatedAtMillis;

  const updateData: Record<string, unknown> = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: options.accountId,
    refreshRecovery: FieldValue.delete(),
    accessTokenExpiresAtMillis,
    connectedAtMillis,
    updatedAtMillis,
    refreshLeaseOwner: FieldValue.delete(),
    refreshLeaseExpiresAtMillis: FieldValue.delete(),
  };

  if (options?.connectedByUid) {
    updateData.connectedByUid = options.connectedByUid;
  }
  if (options?.connectedByEmail) {
    updateData.connectedByEmail = options.connectedByEmail;
  }

  const pendingRef = soundcloudPendingAuthSessionRef(options.connectedByUid!);
  await firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const pending = await transaction.get(pendingRef);
    const auth = await transaction.get(soundcloudAuthStateRef());
    const attempt = await transaction.get(oauthAttemptRef(options.exchangeAttempt));
    if (
      attempt.get('status') !== 'active' ||
      pending.get('state') !== options.state ||
      pending.get('exchangeAttempt') !== options.exchangeAttempt ||
      auth.get('oauthExchangeOwner') !== options.exchangeAttempt
    )
      throw new HttpsError('aborted', 'SoundCloud connection ownership changed during authorization.');
    if (auth.get('accountId') && auth.get('accountId') !== options.accountId) throw new SoundCloudAccountMismatch();
    transaction.set(
      soundcloudAuthStateRef(),
      { ...updateData, oauthExchangeOwner: FieldValue.delete() },
      { merge: true }
    );
    transaction.delete(pendingRef);
    transaction.update(attempt.ref, { status: 'succeeded', completedAt: auth.readTime });
  });

  return {
    connected: true,
    accessTokenExpiresAtMillis,
    connectedAtMillis,
    ...(options?.connectedByEmail ? { connectedByEmail: options.connectedByEmail } : {}),
  };
};

export const createSoundCloudAuthorizationSession = async (
  input: CreateSoundCloudAuthorizationSessionInput,
  beforeEffects: () => Promise<void> = async () => undefined
): Promise<CreateSoundCloudAuthorizationSessionResult> => {
  const clientId = getConfiguredClientId();
  const clientSecret = getConfiguredClientSecret();
  if (!clientId || !clientSecret) {
    throw getSoundCloudSetupError();
  }

  const adminUid = readConfiguredValue(input.adminUid);
  if (!adminUid) {
    throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
  }

  const redirectUri = normalizeRedirectUri(input.redirectUri);
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOAuthState();
  const createdAtMillis = nowMillis();
  const expiresAtMillis = createdAtMillis + PENDING_SOUND_CLOUD_AUTH_TTL_MS;

  await beforeEffects();
  await firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const auth = await transaction.get(soundcloudAuthStateRef());
    const oldOwner = auth.get('oauthExchangeOwner');
    if (oldOwner) {
      if (typeof oldOwner !== 'string' || !/^[a-f0-9-]{36}$/.test(oldOwner))
        throw new HttpsError('failed-precondition', 'SoundCloud authorization ownership needs operator review.');
      const oldAttempt = await transaction.get(oauthAttemptRef(oldOwner));
      const original = oldAttempt.data();
      if (
        !original ||
        original.schemaVersion !== 1 ||
        original.attemptId !== oldOwner ||
        original.status !== 'active' ||
        !(original.claimedAt instanceof Timestamp) ||
        !(original.abandonedAfter instanceof Timestamp) ||
        original.abandonedAfter.seconds !== original.claimedAt.seconds + OAUTH_ABANDONED_AFTER_SECONDS ||
        original.abandonedAfter.nanoseconds !== original.claimedAt.nanoseconds
      )
        throw new HttpsError('failed-precondition', 'SoundCloud authorization attempt needs operator review.');
      if (!nativeTimeReached(auth.readTime, original.abandonedAfter))
        throw new HttpsError(
          'unavailable',
          'A SoundCloud connection is already being authorized. Wait before starting another.'
        );
      if (original.admissionLeaseId) {
        const originalLease = await transaction.get(
          firebaseAdmin.firestore().collection('legacyAdmissionLeases').doc(original.admissionLeaseId)
        );
        if (
          !originalLease.exists ||
          originalLease.get('leaseId') !== original.admissionLeaseId ||
          originalLease.get('domain') !== 'accounts' ||
          originalLease.get('actorUid') !== original.adminUid ||
          originalLease.get('operation') !== 'exchangeSoundCloudAuthCode' ||
          originalLease.get('effectsStarted') !== true ||
          !['active', 'needs_attention'].includes(originalLease.get('state'))
        )
          throw new HttpsError('failed-precondition', 'The original SoundCloud admission needs operator review.');
      }
      // Preserve the original claim and admission. This records supersession of
      // ownership only, never completion or proof of no provider effect.
      transaction.update(oldAttempt.ref, {
        status: 'superseded',
        outcome: 'unknown',
        supersededAt: auth.readTime,
        supersededByAdminUid: adminUid,
        supersedingSessionStateHash: createHash('sha256').update(state).digest('hex'),
      });
      transaction.set(soundcloudAuthStateRef(), { oauthExchangeOwner: FieldValue.delete() }, { merge: true });
    }
    transaction.set(soundcloudPendingAuthSessionRef(adminUid), {
      state,
      codeVerifier,
      redirectUri,
      createdAtMillis,
      expiresAtMillis,
    });
  });

  const profile = currentSandboxProfile();
  if (profile)
    return {
      authorizeUrl: buildSandboxSoundCloudAuthorizeUrl(profile, { redirectUri, state, codeChallenge, clientId }),
      expiresAtMillis,
    };
  const authorizeUrl = new URL('https://secure.soundcloud.com/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);

  return {
    authorizeUrl: authorizeUrl.toString(),
    expiresAtMillis,
  };
};

export const exchangeSoundCloudAuthorizationCode = async (
  input: ExchangeSoundCloudAuthorizationCodeInput,
  beforeEffects: () => Promise<void> = async () => undefined,
  admission?: OAuthAdmission
): Promise<ExchangeSoundCloudAuthorizationCodeResult> => {
  const clientId = getConfiguredClientId();
  const clientSecret = getConfiguredClientSecret();
  if (!clientId || !clientSecret) {
    throw getSoundCloudSetupError();
  }

  const code = readConfiguredValue(input.code);
  const state = readConfiguredValue(input.state);
  if (!code || !state) {
    throw new HttpsError('invalid-argument', 'SoundCloud authorization code and state are required.');
  }

  const connectedByUid = readConfiguredValue(input.connectedByUid ?? undefined);
  if (!connectedByUid) {
    throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
  }

  const pendingSession = await readPendingSoundCloudAuthorizationSession(connectedByUid, state, beforeEffects);
  if (pendingSession.exchangeAttempt)
    throw new HttpsError(
      'failed-precondition',
      'This authorization has already been attempted. Start a new connection from Admin > Advanced.'
    );
  const payload = createTokenPayload({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: pendingSession.redirectUri,
    code_verifier: pendingSession.codeVerifier,
    code,
  });

  const pendingRef = soundcloudPendingAuthSessionRef(connectedByUid);
  const exchangeAttempt = randomUUID();
  await beforeEffects();
  await firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const pending = await transaction.get(pendingRef);
    const auth = await transaction.get(soundcloudAuthStateRef());
    if (
      !pending.exists ||
      pending.get('state') !== state ||
      pending.get('exchangeAttempt') ||
      pending.get('expiresAtMillis') <= nowMillis()
    )
      throw new HttpsError(
        'failed-precondition',
        'This authorization has already been attempted or expired. Start a new connection from Admin > Advanced.'
      );
    // Never race a single-use refresh grant or another administrator's connection.
    const admissionSnapshot = admission
      ? await transaction.get(
          firebaseAdmin.firestore().collection('legacyAdmissionLeases').doc(admission.admissionLeaseId)
        )
      : undefined;
    if (
      admissionSnapshot &&
      (!admissionSnapshot.exists ||
        admissionSnapshot.get('leaseId') !== admission?.admissionLeaseId ||
        admissionSnapshot.get('state') !== 'active' ||
        admissionSnapshot.get('domain') !== 'accounts' ||
        admissionSnapshot.get('actorUid') !== connectedByUid ||
        admissionSnapshot.get('operation') !== 'exchangeSoundCloudAuthCode' ||
        admissionSnapshot.get('effectsStarted') !== true)
    )
      throw new HttpsError('failed-precondition', 'SoundCloud authorization admission ownership changed.');
    const refreshOwner = auth.get('refreshLeaseOwner');
    const refreshExpiry = auth.get('refreshLeaseExpiresAtMillis');
    const refreshLiveOrUnknown =
      refreshOwner &&
      (typeof refreshExpiry !== 'number' ||
        !Number.isFinite(refreshExpiry) ||
        refreshExpiry > auth.readTime.toMillis());
    if (auth.get('oauthExchangeOwner') || refreshLiveOrUnknown)
      throw new HttpsError(
        'unavailable',
        'SoundCloud authorization is busy. Try again after the current connection finishes.'
      );
    transaction.update(pendingRef, { exchangeAttempt, exchangeStatus: 'active' });
    transaction.create(oauthAttemptRef(exchangeAttempt), {
      schemaVersion: 1,
      attemptId: exchangeAttempt,
      status: 'active',
      adminUid: connectedByUid,
      sessionStateHash: createHash('sha256').update(state).digest('hex'),
      claimedAt: auth.readTime,
      abandonedAfter: new Timestamp(auth.readTime.seconds + OAUTH_ABANDONED_AFTER_SECONDS, auth.readTime.nanoseconds),
      ...(admissionSnapshot
        ? {
            admissionLeaseId: admission!.admissionLeaseId,
            admissionReleaseRevision: admissionSnapshot.get('releaseRevision'),
            admissionAcquiredAt: admissionSnapshot.get('acquiredAt'),
          }
        : {}),
      ...(refreshOwner ? { fencedExpiredRefreshOwner: refreshOwner } : {}),
    });
    // Clearing an expired refresh owner is a fence: its late response cannot
    // satisfy the refresh transaction's existing owner/token compare-and-set.
    transaction.set(
      soundcloudAuthStateRef(),
      {
        oauthExchangeOwner: exchangeAttempt,
        ...(refreshOwner
          ? {
              ...releaseRefreshLease(),
              ...(auth.get('refreshRecovery') ? {} : { refreshRecovery: 'outcome_unknown' }),
            }
          : {}),
      },
      { merge: true }
    );
  });
  try {
    const tokens = await postSoundCloudTokenGrant(
      payload,
      'SoundCloud authorization failed. Start a new connection from Admin > Advanced.',
      false
    );
    const accountId = await getAuthenticatedSoundCloudAccountId(tokens.access_token);
    return await writeTokenState(tokens, {
      accountId,
      connectedAtMillis: nowMillis(),
      connectedByUid,
      connectedByEmail: readConfiguredValue(input.connectedByEmail ?? undefined) ?? undefined,
      state,
      exchangeAttempt,
    });
  } catch (error) {
    // A timeout or persistence failure cannot prove that the one-time grant was not consumed.
    // Keep the attempted session and its drain-visible uncertain admission; fresh consent is a new intent.
    try {
      await firebaseAdmin.firestore().runTransaction(async (transaction) => {
        const pending = await transaction.get(pendingRef);
        const auth = await transaction.get(soundcloudAuthStateRef());
        const attempt = await transaction.get(oauthAttemptRef(exchangeAttempt));
        if (attempt.get('status') === 'active')
          transaction.update(attempt.ref, { status: 'uncertain', outcome: 'unknown', failedAt: auth.readTime });
        if (pending.get('exchangeAttempt') === exchangeAttempt)
          transaction.update(pendingRef, { exchangeStatus: 'uncertain' });
        if (auth.get('oauthExchangeOwner') === exchangeAttempt)
          transaction.set(soundcloudAuthStateRef(), { oauthExchangeOwner: FieldValue.delete() }, { merge: true });
      });
    } catch {
      logger.error(
        'SoundCloud authorization cleanup could not be confirmed; attempt retained for explicit consent recovery.',
        { exchangeAttempt }
      );
    }
    if (error instanceof SoundCloudAccountMismatch)
      throw new HttpsError('failed-precondition', 'Select the previously connected SoundCloud account and try again.');
    throw new HttpsError(
      'failed-precondition',
      'The SoundCloud authorization outcome could not be confirmed. Start a new connection from Admin > Advanced; do not retry this authorization code.'
    );
  }
};

export const getSoundCloudAuthStatus = async (): Promise<SoundCloudAuthStatus> => {
  const state = await readAuthState();
  const bootstrapRefreshToken = getBootstrapRefreshToken();
  const clientId = getConfiguredClientId();
  const configured = Boolean(clientId && getConfiguredClientSecret());
  const reconnectRequired = Boolean(
    state?.refreshRecovery || (state?.refreshLeaseOwner && !(Number(state.refreshLeaseExpiresAtMillis) > nowMillis()))
  );
  const tokenSource = state?.refreshToken ? 'firestore' : bootstrapRefreshToken ? 'secret' : 'none';

  return {
    clientId,
    callbackPath: SOUND_CLOUD_CALLBACK_PATH,
    configured,
    connected: tokenSource !== 'none' && !reconnectRequired,
    ...(reconnectRequired ? { reconnectRequired: true as const } : {}),
    ...(state?.accountId ? { accountId: state.accountId } : {}),
    tokenSource,
    ...(typeof state?.accessTokenExpiresAtMillis === 'number'
      ? { accessTokenExpiresAtMillis: state.accessTokenExpiresAtMillis }
      : {}),
    ...(typeof state?.connectedAtMillis === 'number' ? { connectedAtMillis: state.connectedAtMillis } : {}),
    ...(typeof state?.updatedAtMillis === 'number' ? { updatedAtMillis: state.updatedAtMillis } : {}),
    ...(state?.connectedByEmail ? { connectedByEmail: state.connectedByEmail } : {}),
  };
};

const reconnectError = () =>
  createSoundCloudReconnectRequiredError(
    'Reconnect SoundCloud from Admin > Advanced before publishing.',
    undefined,
    true
  );

const refreshSoundCloudTokens = (refreshToken: string) =>
  postSoundCloudTokenGrant(
    createTokenPayload({
      grant_type: 'refresh_token',
      client_id: getConfiguredClientId()!,
      client_secret: getConfiguredClientSecret()!,
      refresh_token: refreshToken,
    }),
    'SoundCloud token refresh failed. Reconnect SoundCloud from Admin > Advanced.',
    true
  );

const releaseRefreshLease = () => ({
  refreshLeaseOwner: FieldValue.delete(),
  refreshLeaseExpiresAtMillis: FieldValue.delete(),
});

const acquireRefreshLease = async (
  rejectedAccessToken?: string
): Promise<
  | { kind: 'token'; accessToken: string }
  | { kind: 'refresh'; refreshToken: string; leaseOwner: string }
  | { kind: 'wait' | 'reconnect' | 'expired' }
> => {
  if (!getConfiguredClientId() || !getConfiguredClientSecret()) throw getSoundCloudSetupError();

  const bootstrapRefreshToken = getBootstrapRefreshToken();
  const leaseOwner = randomUUID();
  return firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const ref = soundcloudAuthStateRef();
    const snapshot = await transaction.get(ref);
    const state = (snapshot.data() as SoundCloudAuthState | undefined) ?? {};
    const currentTimeMillis = snapshot.readTime.toMillis();

    if (state.oauthExchangeOwner) return { kind: 'wait' as const };
    if (state.refreshRecovery) return { kind: 'reconnect' as const };

    if (state.refreshLeaseOwner) {
      const expiry = state.refreshLeaseExpiresAtMillis;
      if (typeof expiry === 'number' && expiry > currentTimeMillis) return { kind: 'wait' as const };
      // A crashed or timed-out owner may have spent this single-use token.
      transaction.set(ref, { refreshRecovery: 'outcome_unknown', ...releaseRefreshLease() }, { merge: true });
      return { kind: 'expired' as const };
    }

    if (state.accessToken !== rejectedAccessToken && isAccessTokenFresh(state, currentTimeMillis)) {
      return { kind: 'token' as const, accessToken: state.accessToken! };
    }

    const refreshToken = state.refreshToken ?? bootstrapRefreshToken;
    if (!refreshToken) throw getSoundCloudNotConnectedError();
    transaction.set(
      ref,
      {
        refreshToken,
        refreshLeaseOwner: leaseOwner,
        refreshLeaseExpiresAtMillis: currentTimeMillis + REFRESH_LEASE_MS,
        updatedAtMillis: currentTimeMillis,
      },
      { merge: true }
    );
    return { kind: 'refresh' as const, refreshToken, leaseOwner };
  });
};

const reportRefreshRecovery = async () => {
  logger.warn('SoundCloud authorization needs reconnection');
  // Keep the original typed error even when alert delivery is unavailable.
  if (currentSandboxProfile()) return;
  await emitSoundCloudReconnectAlertIfNeeded({
    alertCode: 'SOUNDCLOUD_AUTH_RECONNECT_REQUIRED',
    summary: 'Reconnect the SoundCloud account from Admin > Advanced.',
    error: createSoundCloudReconnectRequiredError(
      'SoundCloud rejected the current authorization or its refresh could not be confirmed.'
    ),
  }).catch(() => logger.warn('SoundCloud reconnect alert could not be sent'));
};

const resolveSoundCloudAccessToken = async (rejectedAccessToken?: string): Promise<string> => {
  for (let attempt = 0; attempt < MAX_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
    const resolution = await acquireRefreshLease(rejectedAccessToken);
    if (resolution.kind === 'token') return resolution.accessToken;
    if (resolution.kind === 'reconnect') throw reconnectError();
    if (resolution.kind === 'expired') {
      await reportRefreshRecovery();
      throw reconnectError();
    }
    if (resolution.kind !== 'refresh') {
      await sleep(REFRESH_WAIT_MS);
      continue;
    }

    try {
      const tokens = await refreshSoundCloudTokens(resolution.refreshToken);
      return await firebaseAdmin.firestore().runTransaction(async (transaction) => {
        const ref = soundcloudAuthStateRef();
        const snapshot = await transaction.get(ref);
        const state = snapshot.data() as SoundCloudAuthState | undefined;
        if (state?.refreshLeaseOwner !== resolution.leaseOwner || state.refreshToken !== resolution.refreshToken) {
          if (!state?.refreshRecovery && isAccessTokenFresh(state ?? null, nowMillis())) return state!.accessToken!;
          throw new HttpsError('aborted', 'SoundCloud authorization changed during token refresh. Please retry.');
        }
        const updatedAtMillis = snapshot.readTime.toMillis();
        transaction.set(
          ref,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            accessTokenExpiresAtMillis: updatedAtMillis + tokens.expires_in * 1000,
            updatedAtMillis,
            ...releaseRefreshLease(),
          },
          { merge: true }
        );
        return tokens.access_token;
      });
    } catch (error) {
      const safeToRetry = error instanceof HttpsError && error.code === 'unavailable';
      const result = await firebaseAdmin.firestore().runTransaction(async (transaction) => {
        const ref = soundcloudAuthStateRef();
        const snapshot = await transaction.get(ref);
        const state = snapshot.data() as SoundCloudAuthState | undefined;
        if (state?.refreshLeaseOwner !== resolution.leaseOwner || state.refreshToken !== resolution.refreshToken) {
          if (
            state &&
            !state.refreshRecovery &&
            state.refreshToken !== resolution.refreshToken &&
            isAccessTokenFresh(state, snapshot.readTime.toMillis())
          )
            return { accessToken: state.accessToken };
          return {};
        }
        transaction.set(
          ref,
          {
            ...releaseRefreshLease(),
            ...(!safeToRetry
              ? { refreshRecovery: isSoundCloudReconnectRequiredError(error) ? 'invalid_grant' : 'outcome_unknown' }
              : {}),
          },
          { merge: true }
        );
        return { recoveryStarted: !safeToRetry };
      });
      if (result.accessToken) return result.accessToken;
      if (result.recoveryStarted) {
        await reportRefreshRecovery();
        throw reconnectError();
      }
      throw new HttpsError(
        'unavailable',
        'SoundCloud authorization changed or is temporarily unavailable. Please retry.'
      );
    }
  }

  throw new HttpsError(
    'deadline-exceeded',
    'Timed out waiting for SoundCloud token refresh to complete. Try the publish action again.'
  );
};

export const getSoundCloudAccessToken = (): Promise<string> => resolveSoundCloudAccessToken();

export const refreshSoundCloudAccessToken = async (): Promise<string> =>
  resolveSoundCloudAccessToken((await readAuthState())?.accessToken);

export const runWithSoundCloudAccessToken = async <T>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
  const accessToken = await getSoundCloudAccessToken();
  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 401) throw error;
    return operation(await resolveSoundCloudAccessToken(accessToken));
  }
};

export const soundcloudSecretsWithRuntimeAlerts = [
  soundcloudClientIdSecret,
  soundcloudClientSecretSecret,
  providerEgressRelayTokenSecret,
  runtimeAlertRecipientsSecret,
  functionsSentryDsnSecret,
];

export const soundcloudOAuthSecrets = [
  soundcloudClientIdSecret,
  soundcloudClientSecretSecret,
  providerEgressRelayTokenSecret,
];
