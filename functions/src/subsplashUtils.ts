// Utils file for subsplash functions

import { randomUUID } from 'node:crypto';
import axios, { AxiosRequestConfig, isAxiosError } from 'axios';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import FormData from 'form-data';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getHtmlEdgeBlock } from './helpers/upstreamHttpErrors';
import './providerRelay';

const AUTH_CACHE_ROOT_PATH = 'subsplashAuthSession';
const AUTH_REFRESH_LOCK_PATH = `${AUTH_CACHE_ROOT_PATH}/refreshLock`;
const AUTH_CACHE_PATH = `${AUTH_CACHE_ROOT_PATH}/cache`;
const AUTH_EXPIRY_SKEW_MS = 30_000;
const AUTH_LOCK_LEASE_MS = 40_000;
const AUTH_LOCK_WAIT_TIMEOUT_MS = 40_000;
const AUTH_LOCK_POLL_INTERVAL_MS = 200;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_EDGE_BLOCK_RETRIES = 3;
const SUBSPLASH_API_ORIGIN = 'https://core.subsplash.com';

type EdgeRetryRequestConfig = AxiosRequestConfig & {
  skipSubsplashEdgeRetry?: boolean;
  providerRelayOriginalUrl?: string;
};

type SubsplashAuthCacheRecord = {
  accessToken: string;
  expiresAtMs: number;
  refreshedAtMs: number;
};

type SubsplashAuthLockRecord = {
  ownerToken: string;
  leaseExpiresAtMs: number;
};

let inMemoryAccessToken: string | null = null;
let inMemoryAccessTokenExpiresAtMs = 0;
let inFlightAuthentication: Promise<string> | null = null;

const sleep = async (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

axios.interceptors?.response?.use(undefined, async (error: unknown) => {
  const edgeBlock = getHtmlEdgeBlock(error);
  if (!edgeBlock || !isAxiosError(error)) {
    throw error;
  }

  const config = error.config as EdgeRetryRequestConfig | undefined;
  if (
    !(config?.providerRelayOriginalUrl || config?.url)?.trim().startsWith(`${SUBSPLASH_API_ORIGIN}/`) ||
    (config.providerRelayOriginalUrl || config.url || '').endsWith('/accounts/v1/oauth/token') ||
    config.skipSubsplashEdgeRetry ||
    config.data instanceof FormData
  ) {
    throw error;
  }

  let blockedRequestId = edgeBlock.requestId;
  for (let retry = 1; retry <= MAX_EDGE_BLOCK_RETRIES; retry += 1) {
    logger.warn('Subsplash API request was blocked by its edge network; retrying', {
      retry,
      requestId: blockedRequestId,
    });
    await sleep(300 * (2 ** (retry - 1)));
    try {
      const retryConfig: EdgeRetryRequestConfig = { ...config, skipSubsplashEdgeRetry: true };
      return await axios(retryConfig);
    } catch (retryError) {
      const retryBlock = getHtmlEdgeBlock(retryError);
      if (!retryBlock) throw retryError;
      blockedRequestId = retryBlock.requestId;
    }
  }

  logger.error('Subsplash API request remained blocked by its edge network', {
    requestId: blockedRequestId,
  });
  throw new HttpsError('unavailable', 'Subsplash is temporarily blocking requests from our server. Please retry shortly.');
});

const getDatabaseRef = (path: string) => firebaseAdmin.database().ref(path);

const isAccessTokenFresh = (expiresAtMs: number, nowMs: number = Date.now()): boolean =>
  expiresAtMs - AUTH_EXPIRY_SKEW_MS > nowMs;

const parseAuthCacheRecord = (value: unknown): SubsplashAuthCacheRecord | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<SubsplashAuthCacheRecord>;
  if (
    typeof record.accessToken !== 'string' ||
    !record.accessToken.trim() ||
    typeof record.expiresAtMs !== 'number' ||
    !Number.isFinite(record.expiresAtMs)
  ) {
    return null;
  }

  return {
    accessToken: record.accessToken,
    expiresAtMs: record.expiresAtMs,
    refreshedAtMs:
      typeof record.refreshedAtMs === 'number' && Number.isFinite(record.refreshedAtMs)
        ? record.refreshedAtMs
        : Date.now(),
  };
};

const parseAuthLockRecord = (value: unknown): SubsplashAuthLockRecord | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<SubsplashAuthLockRecord>;
  if (
    typeof record.ownerToken !== 'string' ||
    typeof record.leaseExpiresAtMs !== 'number' ||
    !Number.isFinite(record.leaseExpiresAtMs)
  ) {
    return null;
  }

  return {
    ownerToken: record.ownerToken,
    leaseExpiresAtMs: record.leaseExpiresAtMs,
  };
};

const setInMemoryAuthCache = (record: SubsplashAuthCacheRecord): void => {
  inMemoryAccessToken = record.accessToken;
  inMemoryAccessTokenExpiresAtMs = record.expiresAtMs;
};

const clearInMemoryAuthCache = (): void => {
  inMemoryAccessToken = null;
  inMemoryAccessTokenExpiresAtMs = 0;
};

export const resetSubsplashAuthCacheForTests = async (): Promise<void> => {
  clearInMemoryAuthCache();
  inFlightAuthentication = null;
  await getDatabaseRef(AUTH_CACHE_ROOT_PATH).remove();
};

export const clearSubsplashInMemoryAuthCacheForTests = (): void => {
  clearInMemoryAuthCache();
  inFlightAuthentication = null;
};

const readCachedAuthRecord = async (): Promise<SubsplashAuthCacheRecord | null> => {
  const snapshot = await getDatabaseRef(AUTH_CACHE_PATH).get();
  return parseAuthCacheRecord(snapshot.val());
};

const writeCachedAuthRecord = async (record: SubsplashAuthCacheRecord): Promise<void> => {
  await getDatabaseRef(AUTH_CACHE_PATH).set(record);
};

const acquireAuthRefreshLock = async (ownerToken: string): Promise<void> => {
  const ref = getDatabaseRef(AUTH_REFRESH_LOCK_PATH);
  const deadlineMs = Date.now() + AUTH_LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const nowMs = Date.now();
    const tx = await ref.transaction((currentValue) => {
      const currentRecord = parseAuthLockRecord(currentValue);
      const isExpired = !currentRecord || currentRecord.leaseExpiresAtMs <= nowMs;
      const isOwnedByCaller = currentRecord?.ownerToken === ownerToken;

      if (!isExpired && !isOwnedByCaller) {
        return;
      }

      return {
        ownerToken,
        leaseExpiresAtMs: nowMs + AUTH_LOCK_LEASE_MS,
      } satisfies SubsplashAuthLockRecord;
    });

    if (tx.committed) {
      return;
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for Subsplash auth refresh lock.');
    }

    await sleep(Math.min(AUTH_LOCK_POLL_INTERVAL_MS, remainingMs));
  }
};

const releaseAuthRefreshLock = async (ownerToken: string): Promise<void> => {
  const ref = getDatabaseRef(AUTH_REFRESH_LOCK_PATH);
  await ref.transaction((currentValue) => {
    const currentRecord = parseAuthLockRecord(currentValue);
    if (!currentRecord) {
      return null;
    }
    if (currentRecord.ownerToken !== ownerToken) {
      return currentValue;
    }
    return null;
  });
};

const fetchFreshAccessToken = async (): Promise<SubsplashAuthCacheRecord> => {
  if (!process.env.SUBSPLASH_EMAIL || !process.env.SUBSPLASH_PASSWORD) {
    throw new Error('Missing SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD in environment.');
  }

  let response;
  for (let attempt = 0; ; attempt += 1) {
    // A multipart stream is single-use. A fresh boundary and body are required for every retry.
    const formData = new FormData();
    formData.append('grant_type', 'password');
    formData.append('scope', 'app:9XTSHD');
    formData.append('email', process.env.SUBSPLASH_EMAIL);
    formData.append('password', process.env.SUBSPLASH_PASSWORD);
    const config: AxiosRequestConfig = {
      method: 'post',
      url: 'https://core.subsplash.com/accounts/v1/oauth/token',
      headers: { ...formData.getHeaders() },
      data: formData,
      timeout: 8_000,
    };

    try {
      response = await axios(config);
      break;
    } catch (error) {
      const edgeBlock = getHtmlEdgeBlock(error);
      const transportFailure = isAxiosError(error) && !error.response &&
        ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(error.code || '');
      if (!edgeBlock && !transportFailure) {
        throw error;
      }

      logger.warn('Subsplash token request failed transiently', {
        attempt: attempt + 1,
        requestId: edgeBlock?.requestId,
        failure: edgeBlock ? 'edge-block' : 'transport',
      });
      if (attempt >= MAX_EDGE_BLOCK_RETRIES) {
        throw new HttpsError(
          'unavailable',
          'Subsplash is temporarily blocking requests from our server. Please retry shortly.'
        );
      }
      await sleep(300 * (2 ** attempt));
    }
  }
  const accessToken = response.data?.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Subsplash token response was missing access_token.');
  }

  const expiresInSeconds =
    typeof response.data?.expires_in === 'number' && Number.isFinite(response.data.expires_in)
      ? response.data.expires_in
      : undefined;
  const nowMs = Date.now();
  if (expiresInSeconds === undefined) {
    logger.warn('Subsplash token response was missing expires_in; using fallback TTL.', {
      fallbackTtlMs: DEFAULT_ACCESS_TOKEN_TTL_MS,
    });
  }

  return {
    accessToken,
    expiresAtMs: nowMs + (expiresInSeconds ? expiresInSeconds * 1000 : DEFAULT_ACCESS_TOKEN_TTL_MS),
    refreshedAtMs: nowMs,
  };
};

export const authenticateSubsplash = async (): Promise<string> => {
  if (inMemoryAccessToken && isAccessTokenFresh(inMemoryAccessTokenExpiresAtMs)) {
    return inMemoryAccessToken;
  }

  if (inFlightAuthentication) {
    return inFlightAuthentication;
  }

  const authenticationPromise = (async () => {
    const cachedRecord = await readCachedAuthRecord();
    if (cachedRecord && isAccessTokenFresh(cachedRecord.expiresAtMs)) {
      setInMemoryAuthCache(cachedRecord);
      return cachedRecord.accessToken;
    }

    const ownerToken = randomUUID();
    await acquireAuthRefreshLock(ownerToken);

    try {
      const refreshedCacheRecord = await readCachedAuthRecord();
      if (refreshedCacheRecord && isAccessTokenFresh(refreshedCacheRecord.expiresAtMs)) {
        setInMemoryAuthCache(refreshedCacheRecord);
        return refreshedCacheRecord.accessToken;
      }

      logger.info('authenticating subsplash');
      const freshRecord = await fetchFreshAccessToken();
      await writeCachedAuthRecord(freshRecord);
      setInMemoryAuthCache(freshRecord);
      return freshRecord.accessToken;
    } catch (error) {
      clearInMemoryAuthCache();
      throw error;
    } finally {
      await releaseAuthRefreshLock(ownerToken);
    }
  })();

  inFlightAuthentication = authenticationPromise;

  try {
    return await authenticationPromise;
  } finally {
    if (inFlightAuthentication === authenticationPromise) {
      inFlightAuthentication = null;
    }
  }
};
type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type Headers = {
  'Content-Type'?: string;
  Authority?: string;
  Authorization: string;
  Origin?: string;
  'Accept-Encoding'?: string;
  'Accept-Language'?: string;
  'Cache-Control'?: string;
  Referer?: string;
};
export const createAxiosConfig = (
  endpoint_url: string,
  bearerToken: string,
  method: HTTPMethod,
  data?: unknown,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  additionalHeaders?: any
): AxiosRequestConfig => {
  const headers: Headers = {
    'Cache-Control': 'no-cache',
    Authority: 'core.subsplash.com',
    Origin: 'https://dashboard.subsplash.com',
    Referer: 'https://dashboard.subsplash.com/',
    Authorization: `Bearer ${bearerToken}`,
    ...additionalHeaders,
  };
  if (data) {
    headers['Content-Type'] = 'application/vnd.api+json';
  }
  return {
    method: method,
    url: endpoint_url,
    headers: headers,
    data,
  };
};
