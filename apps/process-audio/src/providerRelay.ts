import { timingSafeEqual } from 'node:crypto';
import express, { type Router } from 'express';

const RELAY_PREFIX = '/internal/provider-relay';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'cache-control',
  'content-type',
  'origin',
  'referer',
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'request-id',
  'x-amz-cf-id',
  'x-amz-cf-pop',
] as const;
const SUBSPLASH_PATH_PREFIXES = [
  '/builder/v1/',
  '/files/v1/',
  '/media/v1/',
  '/tags/v1/',
  '/transcoder/v1/',
];

const isAuthorized = (provided: string | undefined, expected: string): boolean => {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
};

const getUpstreamUrl = (requestUrl: string, method: string): URL | null => {
  const parsed = new URL(requestUrl, 'https://relay.invalid');
  if (parsed.pathname === `${RELAY_PREFIX}/soundcloud-token`) {
    return method === 'POST' && !parsed.search
      ? new URL('https://secure.soundcloud.com/oauth/token')
      : null;
  }

  const subsplashPrefix = `${RELAY_PREFIX}/subsplash`;
  if (!parsed.pathname.startsWith(`${subsplashPrefix}/`)) return null;
  const path = parsed.pathname.slice(subsplashPrefix.length);
  if (path !== '/accounts/v1/oauth/token' && !SUBSPLASH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  return new URL(`${path}${parsed.search}`, 'https://core.subsplash.com');
};

export const createProviderRelayRouter = (
  sharedToken: string | undefined,
  fetchUpstream: typeof fetch = fetch
): Router => {
  const router = express.Router();

  router.use((request, response, next) => {
    if (!sharedToken) {
      response.status(503).json({ error: 'Provider relay is unavailable.' });
      return;
    }
    if (!isAuthorized(request.header('x-provider-relay-token'), sharedToken)) {
      response.status(401).json({ error: 'Unauthorized.' });
      return;
    }
    next();
  });

  router.use(express.raw({ type: () => true, limit: MAX_BODY_BYTES }));

  router.all('*', async (request, response) => {
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      response.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const upstreamUrl = getUpstreamUrl(request.originalUrl, request.method);
    if (!upstreamUrl) {
      response.status(404).json({ error: 'Provider route not found.' });
      return;
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.header(name);
      if (value) headers.set(name, value);
    }

    try {
      const upstream = await fetchUpstream(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : new Uint8Array(request.body || Buffer.alloc(0)),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });

      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > MAX_BODY_BYTES) {
        response.status(502).json({ error: 'Provider response exceeded the relay limit.' });
        return;
      }

      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.status(upstream.status).send(body);
    } catch {
      response.status(502).json({ error: 'Provider relay could not reach the upstream service.' });
    }
  });

  router.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error && error.status === 413 ? 413 : 400;
    response.status(status).json({ error: status === 413 ? 'Provider request exceeded the relay limit.' : 'Invalid provider request.' });
  });

  return router;
};
