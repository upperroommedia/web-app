import { GoogleAuth } from 'google-auth-library';
import type { Database } from 'firebase-admin/database';
import {
  BROWSER_FALLBACK_RUNTIME_CONFIG_PATH,
  type BrowserFallbackRuntimeConfig,
  type BrowserFallbackSessionStatusResponse,
} from '@upperroom/contracts/browserFallback';

const LOCAL_BROWSER_FALLBACK_SERVICE_URL = 'http://127.0.0.1:8090';

const normalizeServiceUrl = (value: string): string => value.replace(/\/fallback\/?$/u, '').replace(/\/+$/u, '');
const getBrowserFallbackAuthMode = (): string => process.env.BROWSER_FALLBACK_AUTH_MODE?.trim().toLowerCase() || 'auto';
const getBrowserFallbackSharedSecret = (): string | undefined => process.env.BROWSER_FALLBACK_SHARED_SECRET?.trim() || undefined;

const shouldUseGoogleIdToken = (serviceUrl: string): boolean => {
  const authMode = getBrowserFallbackAuthMode();
  if (authMode === 'id_token') return true;
  if (authMode === 'shared_secret' || authMode === 'none') return false;

  try {
    return new URL(serviceUrl).hostname.toLowerCase().endsWith('.run.app');
  } catch {
    return false;
  }
};

export async function getBrowserFallbackRuntimeConfig(database: Database): Promise<BrowserFallbackRuntimeConfig> {
  const snapshot = await database.ref(BROWSER_FALLBACK_RUNTIME_CONFIG_PATH).get();
  if (!snapshot.exists()) {
    return {
      serviceUrl: process.env.FUNCTIONS_EMULATOR === 'true' ? LOCAL_BROWSER_FALLBACK_SERVICE_URL : null,
      enabled: process.env.FUNCTIONS_EMULATOR === 'true',
      updatedAt: null,
    };
  }

  const value = snapshot.val() as Partial<BrowserFallbackRuntimeConfig>;
  return {
    serviceUrl: value.serviceUrl ? normalizeServiceUrl(value.serviceUrl) : null,
    enabled: !!value.enabled && !!value.serviceUrl,
    updatedAt: value.updatedAt ?? null,
  };
}

export async function getBrowserFallbackSessionStatus(
  database: Database
): Promise<BrowserFallbackSessionStatusResponse & { reachable: boolean; serviceUrl: string | null }> {
  const runtimeConfig = await getBrowserFallbackRuntimeConfig(database);
  const serviceUrl = runtimeConfig.serviceUrl;

  if (!runtimeConfig.enabled || !serviceUrl) {
    return {
      ok: false,
      service: 'browser-fallback',
      configured: false,
      sessionState: 'unknown',
      profileUpdatedAt: null,
      profileGeneration: null,
      fakeMode: false,
      healthcheckConfigured: false,
      lastCheckedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      reachable: false,
      serviceUrl: null,
    };
  }

  const statusUrl = `${serviceUrl}/session-status`;
  try {
    const headers = new Headers();
    const sharedSecret = getBrowserFallbackSharedSecret();
    if (sharedSecret) {
      headers.set('x-browser-fallback-secret', sharedSecret);
    }

    if (process.env.FUNCTIONS_EMULATOR === 'true' || !shouldUseGoogleIdToken(serviceUrl)) {
      const response = await fetch(statusUrl, { headers });
      const data = (await response.json()) as BrowserFallbackSessionStatusResponse;
      return {
        ...data,
        configured: true,
        reachable: response.ok,
        serviceUrl,
      };
    }

    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(serviceUrl);
    const response = await client.request<BrowserFallbackSessionStatusResponse>({
      url: statusUrl,
      method: 'GET',
      headers: Object.fromEntries(headers.entries()),
    });
    return {
      ...response.data,
      configured: true,
      reachable: true,
      serviceUrl,
    };
  } catch {
    return {
      ok: false,
      service: 'browser-fallback',
      configured: true,
      sessionState: 'unknown',
      profileUpdatedAt: null,
      profileGeneration: null,
      fakeMode: false,
      healthcheckConfigured: false,
      lastCheckedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      reachable: false,
      serviceUrl,
    };
  }
}
