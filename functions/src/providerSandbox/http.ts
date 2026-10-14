import rawAxios, { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse, type RawAxiosHeaders } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getProviderExecutionProfile,
  assertSandboxCatalogReady,
  sandboxProfileDocumentPath,
  type SandboxProviderProfile,
} from './profile';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getDurablePublishingJobId, getPublishingSourceStepIds } from '../temporal/publishing/durableOperationContext';
import type { SandboxRequestContext, StageAssetRef } from './types';

const context = new AsyncLocalStorage<SandboxRequestContext>();
export const withSandboxRequestContext = <T>(value: SandboxRequestContext, run: () => Promise<T>): Promise<T> =>
  context.run(value, run);
export function sandboxRequestContext(): SandboxRequestContext | undefined {
  const active = context.getStore();
  if (active) return { ...active, sourceStepIds: active.sourceStepIds && [...active.sourceStepIds] };
  const jobId = getDurablePublishingJobId();
  if (!jobId) return undefined;
  return { jobId, sourceStepIds: getPublishingSourceStepIds(jobId) };
}
export function currentSandboxProfile(): SandboxProviderProfile | undefined {
  const profile = getProviderExecutionProfile();
  return profile.mode === 'sandbox' ? profile : undefined;
}
async function requireReady(profile: SandboxProviderProfile): Promise<void> {
  const marker = await firebaseAdmin.firestore().doc(sandboxProfileDocumentPath(profile)).get();
  assertSandboxCatalogReady(profile, marker.data());
}
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'PROVIDER_SANDBOX_TRANSPORT_REQUIRED' });
};
export const SANDBOX_MEDIA_ORIGIN = 'https://provider-sandbox.invalid';
const providerFor = (url: URL): 'subsplash' | 'soundcloud' | undefined =>
  url.origin === 'https://core.subsplash.com'
    ? 'subsplash'
    : ['https://api.soundcloud.com', 'https://secure.soundcloud.com'].includes(url.origin)
    ? 'soundcloud'
    : undefined;
const safeStageInput = (url: URL): boolean => {
  const buckets = ['urm-app-staging.firebasestorage.app', 'urm-app-staging.appspot.com', 'urm-app-staging-images'];
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.origin === 'https://storage.googleapis.com')
    return buckets.includes(decodeURIComponent(url.pathname.split('/')[1] ?? ''));
  if (url.origin === 'https://firebasestorage.googleapis.com') {
    const match = /^\/v0\/b\/([^/]+)\/o\/.+/.exec(url.pathname);
    return Boolean(match && buckets.includes(decodeURIComponent(match[1])));
  }
  return false;
};
function requestUrl(config: AxiosRequestConfig): URL {
  if (typeof config.url !== 'string') return fail('An absolute provider URL is required');
  const url = new URL(config.url.trim());
  if (url.username || url.password || url.hash || config.baseURL) return fail('Provider URL authority is invalid');
  return url;
}
async function request<T = any, R = AxiosResponse<T>, D = any>(
  input: AxiosRequestConfig<D> | string,
  options?: AxiosRequestConfig<D>
): Promise<R> {
  const config: AxiosRequestConfig<D> = typeof input === 'string' ? { ...options, url: input } : input;
  const profile = getProviderExecutionProfile();
  if (profile.mode === 'live') return (await rawAxios(config)) as R;
  const url = requestUrl(config),
    method = (config.method ?? 'GET').toUpperCase();
  const headers = AxiosHeaders.from(config.headers as RawAxiosHeaders | AxiosHeaders | undefined);
  const scope = sandboxRequestContext();
  let response: { status: number; data: unknown; headers: Record<string, string> };
  if (url.origin === 'https://secure.soundcloud.com' && url.pathname === '/oauth/token' && method === 'POST') {
    const { exchangeSandboxSoundCloudToken } = await import('./oauth');
    const payload =
      typeof config.data === 'string'
        ? new URLSearchParams(config.data)
        : config.data instanceof URLSearchParams
        ? config.data
        : fail('Synthetic OAuth requires an encoded grant');
    response = { status: 200, data: await exchangeSandboxSoundCloudToken(profile, payload), headers: {} };
  } else if (url.origin === 'https://api.soundcloud.com' && url.pathname === '/me' && method === 'GET') {
    const { verifySandboxSoundCloudAccessToken } = await import('./oauth');
    const authorization = headers.get('Authorization');
    const token = typeof authorization === 'string' ? /^(?:OAuth|Bearer) (\S+)$/.exec(authorization)?.[1] : undefined;
    if (!token) return fail('Synthetic SoundCloud authorization is required');
    response = { status: 200, data: await verifySandboxSoundCloudAccessToken(profile, token), headers: {} };
  } else if (url.origin === SANDBOX_MEDIA_ORIGIN) {
    await requireReady(profile);
    if (!scope) return fail('Sandbox uploads require the trusted durable job context');
    if (method !== 'PUT' || !config.data || typeof (config.data as any)[Symbol.asyncIterator] !== 'function')
      return fail('Virtual provider uploads require a bounded byte stream');
    const { uploadSandboxAllocation } = await import('./service');
    const type = headers.get('Content-Type'),
      length = headers.get('Content-Length');
    response = await uploadSandboxAllocation(
      profile,
      url.toString(),
      config.data as unknown as AsyncIterable<Uint8Array>,
      {
        contentType: typeof type === 'string' ? type : '',
        ...(length !== undefined && length !== null ? { contentLength: Number(length) } : {}),
        maxBytes: 25 * 1024 * 1024,
      },
      scope
    );
  } else {
    const provider = providerFor(url);
    if (provider) {
      await requireReady(profile);
      const authorization = headers.get('Authorization');
      if (provider === 'soundcloud') {
        const { verifySandboxSoundCloudAccessToken } = await import('./oauth');
        const token =
          typeof authorization === 'string' ? /^(?:OAuth|Bearer) (\S+)$/.exec(authorization)?.[1] : undefined;
        if (!token) return fail('Synthetic SoundCloud authorization is required');
        await verifySandboxSoundCloudAccessToken(profile, token);
      } else if (authorization !== `Bearer provider-sandbox:${profile.profileId}:subsplash`) {
        return fail('Synthetic Subsplash authorization is required');
      }
      if (!['GET', 'HEAD'].includes(method) && !scope)
        return fail('Sandbox mutations require the trusted durable job context');
      const { handleSandboxRequest } = await import('./service');
      response = await handleSandboxRequest(profile, {
        provider,
        method,
        url: url.toString(),
        data: config.data,
        params: config.params,
        context: scope,
      });
    } else if (method === 'GET' && safeStageInput(url)) {
      // Source media is genuine staging data; never forward provider authorization to it.
      return (await rawAxios.request({ ...config, headers: {}, maxRedirects: 0 })) as R;
    } else return fail('Staging provider requests cannot leave the isolated simulator');
  }
  const result: AxiosResponse = {
    ...response,
    statusText: String(response.status),
    config: { ...config, headers },
    headers: response.headers,
  };
  const validate = config.validateStatus ?? ((status: number) => status >= 200 && status < 300);
  if (!validate(response.status))
    throw new rawAxios.AxiosError(
      'Simulated provider request rejected',
      'ERR_BAD_RESPONSE',
      result.config,
      undefined,
      result
    );
  return result as R;
}
type ProviderHttpClient = typeof request &
  Pick<
    typeof rawAxios,
    | 'get'
    | 'post'
    | 'put'
    | 'patch'
    | 'delete'
    | 'head'
    | 'options'
    | 'request'
    | 'postForm'
    | 'putForm'
    | 'patchForm'
    | 'isAxiosError'
    | 'AxiosError'
    | 'AxiosHeaders'
    | 'isCancel'
    | 'CancelToken'
    | 'interceptors'
    | 'defaults'
  > & { create(): never };
const providerHttp = Object.assign(request, {
  isAxiosError: rawAxios.isAxiosError,
  AxiosError: rawAxios.AxiosError,
  AxiosHeaders,
  isCancel: rawAxios.isCancel,
  CancelToken: rawAxios.CancelToken,
  interceptors: rawAxios.interceptors,
  defaults: rawAxios.defaults,
  request,
  get: async (url: string, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.get(url, config)
      : request({ ...config, url, method: 'GET' }),
  delete: async (url: string, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.delete(url, config)
      : request({ ...config, url, method: 'DELETE' }),
  head: async (url: string, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.head(url, config)
      : request({ ...config, url, method: 'HEAD' }),
  options: async (url: string, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.options(url, config)
      : request({ ...config, url, method: 'OPTIONS' }),
  post: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.post(url, data, config)
      : request({ ...config, url, data, method: 'POST' }),
  put: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.put(url, data, config)
      : request({ ...config, url, data, method: 'PUT' }),
  patch: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.patch(url, data, config)
      : request({ ...config, url, data, method: 'PATCH' }),
  postForm: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.postForm(url, data, config)
      : request({ ...config, url, data, method: 'POST' }),
  putForm: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.putForm(url, data, config)
      : request({ ...config, url, data, method: 'PUT' }),
  patchForm: async (url: string, data?: unknown, config?: AxiosRequestConfig) =>
    getProviderExecutionProfile().mode === 'live'
      ? rawAxios.patchForm(url, data, config)
      : request({ ...config, url, data, method: 'PATCH' }),
  create: () => fail('Independent provider HTTP clients bypass the isolated transport'),
}) as unknown as ProviderHttpClient;
export default providerHttp;

/** Native-fetch readiness must use this boundary too; virtual media never enters DNS. */
export async function probeSandboxProviderMedia(url: string): Promise<boolean | undefined> {
  const profile = currentSandboxProfile();
  if (!profile) return undefined;
  const parsed = new URL(url);
  if (parsed.origin !== SANDBOX_MEDIA_ORIGIN) return fail('Simulated provider media must use an owned virtual URL');
  await requireReady(profile);
  const { probeSandboxMedia } = await import('./service');
  const proof = await probeSandboxMedia(profile, parsed.toString(), { maxBytes: 1024 }, sandboxRequestContext());
  return proof.ok && proof.size > 0 && /^audio\//.test(proof.contentType);
}

export async function sandboxStageAsset(input: string, defaultBucket?: string): Promise<StageAssetRef> {
  const profile = currentSandboxProfile();
  if (!profile) return fail('Sandbox asset resolution is not available in production');
  await requireReady(profile);
  const { resolveStageAsset } = await import('./assets');
  return resolveStageAsset(profile, input, defaultBucket);
}
export async function sandboxTrackMutation(
  input: { trackId?: string; metadata: Record<string, unknown>; audio?: StageAssetRef; artwork?: StageAssetRef },
  accessToken: string
): Promise<any> {
  const profile = currentSandboxProfile();
  if (!profile) return fail('Sandbox track mutation is not available in production');
  await requireReady(profile);
  const { verifySandboxSoundCloudAccessToken } = await import('./oauth');
  await verifySandboxSoundCloudAccessToken(profile, accessToken);
  const service = await import('./service');
  const scope = sandboxRequestContext();
  if (!scope) return fail('Sandbox tracks require the trusted durable job context');
  const response = input.trackId
    ? await service.updateSandboxSoundCloudTrack(profile, input, scope)
    : await service.createSandboxSoundCloudTrack(profile, input, scope);
  return response.data;
}

/** Preserve the real provider's bounded GET readiness protocol in production. */
export async function probeProviderAudioUrl(initial: string, token: string): Promise<boolean> {
  const simulated = await probeSandboxProviderMedia(initial);
  if (simulated !== undefined) return simulated;
  let url = new URL(initial);
  for (let redirects = 0; redirects < 5; redirects += 1) {
    if (url.protocol !== 'https:') return false;
    const headers: Record<string, string> = { Range: 'bytes=0-1023' };
    if (url.hostname === 'core.subsplash.com') headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return false;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return false;
    }
    const mime = response.headers.get('content-type') ?? '';
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      return (
        !first.done && first.value.byteLength > 0 && (/^audio\//.test(mime) || /^application\/octet-stream/.test(mime))
      );
    } finally {
      await reader.cancel();
    }
  }
  return false;
}
