import axios, { type InternalAxiosRequestConfig } from 'axios';
import { defineSecret } from 'firebase-functions/params';

export const providerEgressRelayTokenSecret = defineSecret('PROVIDER_EGRESS_RELAY_TOKEN');

type ProviderRelayRequestConfig = InternalAxiosRequestConfig & {
  providerRelayOriginalUrl?: string;
};

const getRelayOrigin = (): string | null => {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (project === 'urm-app') return 'https://yt-worker.upperroommedia.org';
  if (project === 'urm-app-staging') return 'https://yt-worker-staging.upperroommedia.org';
  return null;
};

export const getProviderRelayUrl = (originalUrl: string, relayOrigin: string): string | null => {
  let upstream: URL;
  try {
    upstream = new URL(originalUrl.trim());
  } catch {
    return null;
  }

  if (upstream.origin === 'https://secure.soundcloud.com' && upstream.pathname === '/oauth/token') {
    return `${relayOrigin}/internal/provider-relay/soundcloud-token`;
  }
  if (upstream.origin === 'https://core.subsplash.com') {
    return `${relayOrigin}/internal/provider-relay/subsplash${upstream.pathname}${upstream.search}`;
  }
  return null;
};

axios.interceptors.request.use((request) => {
  const config = request as ProviderRelayRequestConfig;
  const sharedToken = process.env.PROVIDER_EGRESS_RELAY_TOKEN?.trim();
  const relayOrigin = getRelayOrigin();
  if (!sharedToken || !relayOrigin || !config.url || config.providerRelayOriginalUrl) return config;

  const relayUrl = getProviderRelayUrl(config.url, relayOrigin);
  if (!relayUrl) return config;

  config.providerRelayOriginalUrl = config.url;
  config.url = relayUrl;
  config.headers.set('x-provider-relay-token', sharedToken);
  config.maxRedirects = 0;
  return config;
});
