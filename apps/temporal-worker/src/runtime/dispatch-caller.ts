import { OAuth2Client, type TokenPayload } from 'google-auth-library';
type DispatchHeaders = Readonly<Record<string, string | string[] | undefined>>;

export type DispatchRoute = 'event' | 'scheduler';
export interface DispatchCaller { kind: DispatchRoute; subject: string }
export interface DispatchAuthorization {
  verify(headers: DispatchHeaders, route: DispatchRoute, signal: AbortSignal): Promise<DispatchCaller>;
  drain(): Promise<void>;
}
interface Binding { projectId: string; buildId: string; audience: string; eventSubject: string; schedulerSubject: string }
const fail = (): never => { throw new Error('DISPATCH_CALLER_UNCONFIRMED'); };
function validate(binding: Binding): void {
  let url: URL;
  try { url = new URL(binding.audience); } catch { return fail(); }
  const service = `urm-dispatch-${binding.buildId.slice(0, 20)}`;
  if (binding.projectId !== 'urm-app-staging' || !/^[a-f0-9]{40}$/.test(binding.buildId) ||
    url.origin !== binding.audience || url.protocol !== 'https:' || url.username || url.password || url.port ||
    !url.hostname.startsWith(`${service}-`) || !/^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/.test(url.hostname) ||
    !/^[0-9]{10,30}$/.test(binding.eventSubject) || !/^[0-9]{10,30}$/.test(binding.schedulerSubject) ||
    binding.eventSubject === binding.schedulerSubject) fail();
}
/** Controlled-observation seam, never selected by runtime configuration. Native
 * entry below supplies only Google's actual cryptographic verifier and fixed cert transport.
 */
export function observeDispatchCallerAuthorization(binding: Binding,
  verify: (token: string, audience: string, signal: AbortSignal) => Promise<TokenPayload | undefined>, timeoutMs = 10000): DispatchAuthorization {
  validate(binding);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail();
  let active: Promise<unknown> | undefined, controller: AbortController | undefined, stopped = false;
  return {
    async verify(headers, route, signal) {
      const authorization = headers.authorization;
      if (stopped || active || signal.aborted || !['event', 'scheduler'].includes(route) ||
        headers['x-serverless-authorization'] !== undefined || typeof authorization !== 'string' ||
        authorization.length > 16384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) return fail();
      const token = authorization.slice(7), started = Date.now(), owned = new AbortController();
      controller = owned;
      const abort = () => owned.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('DISPATCH_CALLER_UNCONFIRMED'));
        owned.signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = Promise.resolve().then(() => {
        if (owned.signal.aborted) return fail();
        return verify(token, binding.audience, owned.signal);
      }).finally(() => { if (controller === owned) { active = undefined; controller = undefined; } });
      active = work;
      try {
        const payload = await Promise.race([work, aborted]);
        const now = Date.now(), seconds = Math.floor(now / 1000);
        const subject = route === 'event' ? binding.eventSubject : binding.schedulerSubject;
        const email = `td-${route === 'event' ? 'e' : 's'}-${binding.buildId.slice(0, 20)}@${binding.projectId}.iam.gserviceaccount.com`;
        if (stopped || signal.aborted || owned.signal.aborted || now - started >= timeoutMs || !payload ||
          payload.aud !== binding.audience || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
          payload.sub !== subject || payload.email !== email || payload.email_verified !== true ||
          !Number.isSafeInteger(payload.exp) || payload.exp <= seconds || !Number.isSafeInteger(payload.iat) ||
          payload.iat > seconds + 5 || payload.exp - payload.iat > 3605) fail();
        return { kind: route, subject };
      } catch { return fail(); }
      finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (onAbort) owned.signal.removeEventListener('abort', onAbort);
      }
    },
    async drain() { stopped = true; controller?.abort(); await active?.catch(() => undefined); },
  };
}

/** Raw tokens and Google verifier errors stay in memory and never reach receipts,
 * logs, responses or error causes. Unsupported stripped-token delivery fails closed.
 */
export function nativeDispatchCallerAuthorization(binding: Binding): DispatchAuthorization {
  validate(binding);
  if (process.env.K_SERVICE !== `urm-dispatch-${binding.buildId.slice(0, 20)}`) fail();
  const client = new OAuth2Client();
  let signal: AbortSignal | undefined;
  installDispatchCertificateTransport(client, () => signal);
  return observeDispatchCallerAuthorization(binding, async (token, audience, current) => {
    signal = current;
    const ticket = await client.verifyIdToken({ idToken: token, audience, maxExpiry: 3600 });
    return ticket.getPayload();
  });
}

/** Installed on the real Google client's Gaxios pipeline; test adapters may observe
 * its requests, while native runtime has no endpoint/transport override. */
export function installDispatchCertificateTransport(client: OAuth2Client, getSignal: () => AbortSignal | undefined, timeoutMs = 8000): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) fail();
  client.transporter.interceptors.request.add({ resolved: async config => {
    const signal = getSignal();
    if (!signal || signal.aborted || !['https://www.googleapis.com/oauth2/v1/certs',
      'https://www.googleapis.com/oauth2/v3/certs'].includes(String(config.url))) return fail();
    // Gaxios has already normalized its input options before interceptors run.
    // Set actual prepared fetch controls and a real deadline signal here.
    config.signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    config.retry = false; config.retryConfig = { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] };
    config.redirect = 'error'; config.follow = 0;
    config.size = 131072; config.maxContentLength = 131072;
    return config;
  } });
}
