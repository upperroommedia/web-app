/**
 * SoundCloud OAuth token management for Firebase callable functions.
 *
 * SoundCloud's documented OAuth flow issues short-lived access tokens and
 * refresh tokens that can mint fresh access tokens without another user login.
 * After the initial admin consent flow, we persist the refresh token in
 * Firestore and refresh access tokens automatically for publish/edit/delete.
 */
import axios, { isAxiosError } from 'axios';
import { randomUUID } from 'node:crypto';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';
import { createSoundCloudReconnectRequiredError } from './soundcloudAuthErrors';

const SOUND_CLOUD_TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const SOUND_CLOUD_AUTH_STATE_COLLECTION = '_integrationAuth';
const SOUND_CLOUD_AUTH_STATE_DOC = 'soundcloud';
const SOUND_CLOUD_CALLBACK_PATH = '/auth/soundcloud/callback';
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_LEASE_MS = 60 * 1000;
const REFRESH_WAIT_MS = 750;
const MAX_REFRESH_WAIT_ATTEMPTS = 10;

export type SoundCloudAuthState = {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAtMillis?: number;
  connectedAtMillis?: number;
  connectedByUid?: string;
  connectedByEmail?: string;
  refreshLeaseOwner?: string;
  refreshLeaseExpiresAtMillis?: number;
  updatedAtMillis?: number;
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
  tokenSource: 'firestore' | 'secret' | 'none';
  accessTokenExpiresAtMillis?: number;
  connectedAtMillis?: number;
  connectedByEmail?: string;
  updatedAtMillis?: number;
};

export type ExchangeSoundCloudAuthorizationCodeInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  connectedByUid?: string;
  connectedByEmail?: string;
};

export type ExchangeSoundCloudAuthorizationCodeResult = {
  connected: true;
  accessTokenExpiresAtMillis: number;
  connectedAtMillis: number;
  connectedByEmail?: string;
};

const soundcloudClientIdSecret = defineSecret('SOUNDCLOUD_CLIENT_ID');
const soundcloudClientSecretSecret = defineSecret('SOUNDCLOUD_CLIENT_SECRET');

const soundcloudAuthStateRef = firebaseAdmin
  .firestore()
  .collection(SOUND_CLOUD_AUTH_STATE_COLLECTION)
  .doc(SOUND_CLOUD_AUTH_STATE_DOC);

const readConfiguredValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const getConfiguredClientId = (): string | null =>
  readConfiguredValue(soundcloudClientIdSecret.value()) ?? readConfiguredValue(process.env.SOUNDCLOUD_CLIENT_ID);

const getConfiguredClientSecret = (): string | null =>
  readConfiguredValue(soundcloudClientSecretSecret.value()) ?? readConfiguredValue(process.env.SOUNDCLOUD_CLIENT_SECRET);

const getBootstrapRefreshToken = (): string | null =>
  readConfiguredValue(process.env.SOUNDCLOUD_REFRESH_TOKEN);

const nowMillis = (): number => Date.now();

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
  const snapshot = await soundcloudAuthStateRef.get();
  if (!snapshot.exists) {
    return null;
  }
  return snapshot.data() as SoundCloudAuthState;
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
  invalidGrantMessage: string
): Promise<Required<RefreshGrantResponse>> => {
  try {
    const response = await axios.post<RefreshGrantResponse>(SOUND_CLOUD_TOKEN_URL, payload.toString(), {
      headers: {
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const accessToken = readConfiguredValue(response.data?.access_token);
    const refreshToken = readConfiguredValue(response.data?.refresh_token);
    const expiresIn = response.data?.expires_in;

    if (!accessToken || !refreshToken || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
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
      logger.error('SoundCloud token exchange failed', { status, soundCloudError });

      if (status === 400 || status === 401) {
        throw createSoundCloudReconnectRequiredError(invalidGrantMessage, soundCloudError);
      }

      throw new HttpsError('internal', 'SoundCloud token exchange failed unexpectedly.', soundCloudError);
    }

    throw error;
  }
};

const writeTokenState = async (
  tokens: Required<RefreshGrantResponse>,
  options?: {
    connectedAtMillis?: number;
    connectedByUid?: string;
    connectedByEmail?: string;
  }
): Promise<ExchangeSoundCloudAuthorizationCodeResult> => {
  const updatedAtMillis = nowMillis();
  const accessTokenExpiresAtMillis = updatedAtMillis + tokens.expires_in * 1000;
  const connectedAtMillis = options?.connectedAtMillis ?? updatedAtMillis;

  const updateData: Record<string, unknown> = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAtMillis,
    connectedAtMillis,
    updatedAtMillis,
    refreshLeaseOwner: firebaseAdmin.firestore.FieldValue.delete(),
    refreshLeaseExpiresAtMillis: firebaseAdmin.firestore.FieldValue.delete(),
  };

  if (options?.connectedByUid) {
    updateData.connectedByUid = options.connectedByUid;
  }
  if (options?.connectedByEmail) {
    updateData.connectedByEmail = options.connectedByEmail;
  }

  await soundcloudAuthStateRef.set(updateData, { merge: true });

  return {
    connected: true,
    accessTokenExpiresAtMillis,
    connectedAtMillis,
    ...(options?.connectedByEmail ? { connectedByEmail: options.connectedByEmail } : {}),
  };
};

export const exchangeSoundCloudAuthorizationCode = async (
  input: ExchangeSoundCloudAuthorizationCodeInput
): Promise<ExchangeSoundCloudAuthorizationCodeResult> => {
  const clientId = getConfiguredClientId();
  const clientSecret = getConfiguredClientSecret();
  if (!clientId || !clientSecret) {
    throw getSoundCloudSetupError();
  }

  const code = readConfiguredValue(input.code);
  const codeVerifier = readConfiguredValue(input.codeVerifier);
  if (!code || !codeVerifier) {
    throw new HttpsError('invalid-argument', 'SoundCloud authorization code and verifier are required.');
  }

  const redirectUri = normalizeRedirectUri(input.redirectUri);
  const payload = createTokenPayload({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    code,
  });

  const tokens = await postSoundCloudTokenGrant(
    payload,
    'SoundCloud authorization failed. Start the connection flow again from Admin > Advanced and approve access.'
  );

  return writeTokenState(tokens, {
    connectedAtMillis: nowMillis(),
    connectedByUid: readConfiguredValue(input.connectedByUid ?? undefined) ?? undefined,
    connectedByEmail: readConfiguredValue(input.connectedByEmail ?? undefined) ?? undefined,
  });
};

export const getSoundCloudAuthStatus = async (): Promise<SoundCloudAuthStatus> => {
  const state = await readAuthState();
  const bootstrapRefreshToken = getBootstrapRefreshToken();
  const clientId = getConfiguredClientId();
  const configured = Boolean(clientId && getConfiguredClientSecret());
  const tokenSource = state?.refreshToken ? 'firestore' : bootstrapRefreshToken ? 'secret' : 'none';

  return {
    clientId,
    callbackPath: SOUND_CLOUD_CALLBACK_PATH,
    configured,
    connected: tokenSource !== 'none',
    tokenSource,
    ...(typeof state?.accessTokenExpiresAtMillis === 'number'
      ? { accessTokenExpiresAtMillis: state.accessTokenExpiresAtMillis }
      : {}),
    ...(typeof state?.connectedAtMillis === 'number' ? { connectedAtMillis: state.connectedAtMillis } : {}),
    ...(typeof state?.updatedAtMillis === 'number' ? { updatedAtMillis: state.updatedAtMillis } : {}),
    ...(state?.connectedByEmail ? { connectedByEmail: state.connectedByEmail } : {}),
  };
};

const refreshSoundCloudTokens = async (refreshToken: string): Promise<Required<RefreshGrantResponse>> => {
  const clientId = getConfiguredClientId();
  const clientSecret = getConfiguredClientSecret();
  if (!clientId || !clientSecret) {
    throw getSoundCloudSetupError();
  }

  const payload = createTokenPayload({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  return postSoundCloudTokenGrant(
    payload,
    'SoundCloud token refresh failed. Reconnect SoundCloud from Admin > Advanced.'
  );
};

const clearRefreshLease = async (): Promise<void> => {
  await soundcloudAuthStateRef.set(
    {
      refreshLeaseOwner: firebaseAdmin.firestore.FieldValue.delete(),
      refreshLeaseExpiresAtMillis: firebaseAdmin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );
};

const acquireRefreshLease = async (
  forceRefresh: boolean
): Promise<
  | { kind: 'token'; accessToken: string }
  | { kind: 'refresh'; refreshToken: string }
  | { kind: 'wait' }
> => {
  const clientId = getConfiguredClientId();
  const clientSecret = getConfiguredClientSecret();
  if (!clientId || !clientSecret) {
    throw getSoundCloudSetupError();
  }

  const bootstrapRefreshToken = getBootstrapRefreshToken();
  const leaseOwner = randomUUID();
  const currentTimeMillis = nowMillis();

  return firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(soundcloudAuthStateRef);
    const state = (snapshot.exists ? (snapshot.data() as SoundCloudAuthState) : null) ?? {};

    if (!forceRefresh && isAccessTokenFresh(state, currentTimeMillis)) {
      return { kind: 'token' as const, accessToken: state.accessToken! };
    }

    const activeRefreshToken = state.refreshToken ?? bootstrapRefreshToken;
    if (!activeRefreshToken) {
      throw getSoundCloudNotConnectedError();
    }

    const hasActiveLease =
      typeof state.refreshLeaseExpiresAtMillis === 'number' && state.refreshLeaseExpiresAtMillis > currentTimeMillis;

    if (hasActiveLease) {
      return { kind: 'wait' as const };
    }

    transaction.set(
      soundcloudAuthStateRef,
      {
        refreshToken: activeRefreshToken,
        refreshLeaseOwner: leaseOwner,
        refreshLeaseExpiresAtMillis: currentTimeMillis + REFRESH_LEASE_MS,
        updatedAtMillis: currentTimeMillis,
      },
      { merge: true }
    );

    return {
      kind: 'refresh' as const,
      refreshToken: activeRefreshToken,
    };
  });
};

const resolveSoundCloudAccessToken = async (forceRefresh: boolean): Promise<string> => {
  for (let attempt = 0; attempt < MAX_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
    const resolution = await acquireRefreshLease(forceRefresh);

    if (resolution.kind === 'token') {
      return resolution.accessToken;
    }

    if (resolution.kind === 'wait') {
      await sleep(REFRESH_WAIT_MS);
      continue;
    }

    try {
      const refreshedTokens = await refreshSoundCloudTokens(resolution.refreshToken);
      const existingState = await readAuthState();
      await writeTokenState(refreshedTokens, {
        connectedAtMillis: existingState?.connectedAtMillis,
        connectedByUid: existingState?.connectedByUid,
        connectedByEmail: existingState?.connectedByEmail,
      });
      return refreshedTokens.access_token;
    } catch (error) {
      await clearRefreshLease();
      throw error;
    }
  }

  const currentState = await readAuthState();
  const currentTimeMillis = nowMillis();
  if (isAccessTokenFresh(currentState, currentTimeMillis)) {
    return currentState.accessToken!;
  }

  throw new HttpsError(
    'deadline-exceeded',
    'Timed out waiting for SoundCloud token refresh to complete. Try the publish action again.'
  );
};

export const getSoundCloudAccessToken = async (): Promise<string> => resolveSoundCloudAccessToken(false);

export const refreshSoundCloudAccessToken = async (): Promise<string> => resolveSoundCloudAccessToken(true);

export const runWithSoundCloudAccessToken = async <T>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
  const accessToken = await getSoundCloudAccessToken();

  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 401) {
      throw error;
    }

    logger.warn('SoundCloud request returned 401; attempting a single token refresh and retry.');
    const refreshedAccessToken = await refreshSoundCloudAccessToken();
    return operation(refreshedAccessToken);
  }
};

export const soundcloudSecretsWithRuntimeAlerts = [
  soundcloudClientIdSecret,
  soundcloudClientSecretSecret,
  runtimeAlertRecipientsSecret,
];

export const soundcloudOAuthSecrets = [soundcloudClientIdSecret, soundcloudClientSecretSecret];
