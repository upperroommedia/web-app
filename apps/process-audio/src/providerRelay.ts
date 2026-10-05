import { timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import express, { type Router } from 'express';

const RELAY_PREFIX = '/internal/provider-relay';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SUBSPLASH_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SOUND_CLOUD_TRACK_BYTES = 4 * 1024 * 1024 * 1024;
const SOUND_CLOUD_TRACK_TIMEOUT_MS = 8 * 60 * 1000;
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
const SUBSPLASH_PATH_PREFIXES = ['/builder/v1/', '/files/v1/', '/media/v1/', '/tags/v1/', '/transcoder/v1/'];

const isAuthorized = (provided: string | undefined, expected: string): boolean => {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
};

const getUpstreamUrl = (requestUrl: string, method: string): URL | null => {
  const parsed = new URL(requestUrl, 'https://relay.invalid');
  if (parsed.pathname === `${RELAY_PREFIX}/soundcloud-token`) {
    return method === 'POST' && !parsed.search ? new URL('https://secure.soundcloud.com/oauth/token') : null;
  }

  const soundCloudTracksPrefix = `${RELAY_PREFIX}/soundcloud/tracks`;
  if (!parsed.search && parsed.pathname === soundCloudTracksPrefix && method === 'POST') {
    return new URL('https://api.soundcloud.com/tracks');
  }
  if (
    !parsed.search &&
    parsed.pathname.startsWith(`${soundCloudTracksPrefix}/`) &&
    /^\/[^/]+$/.test(parsed.pathname.slice(soundCloudTracksPrefix.length)) &&
    ['PUT', 'DELETE'].includes(method)
  ) {
    return new URL(`https://api.soundcloud.com/tracks${parsed.pathname.slice(soundCloudTracksPrefix.length)}`);
  }

  const subsplashPrefix = `${RELAY_PREFIX}/subsplash`;
  if (!parsed.pathname.startsWith(`${subsplashPrefix}/`)) return null;
  const path = parsed.pathname.slice(subsplashPrefix.length);
  if (path !== '/accounts/v1/oauth/token' && !SUBSPLASH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)))
    return null;
  return new URL(`${path}${parsed.search}`, 'https://core.subsplash.com');
};

const getResponseBodyLimit = (upstreamUrl: URL): number =>
  upstreamUrl.origin === 'https://core.subsplash.com' ? MAX_SUBSPLASH_RESPONSE_BYTES : MAX_BODY_BYTES;

const readBoundedResponseBody = async (upstream: Response, maxBytes: number): Promise<Buffer | null> => {
  const declaredLength = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await upstream.body?.cancel().catch(() => undefined);
    return null;
  }

  if (!upstream.body) return Buffer.alloc(0);

  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, receivedBytes);
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

  const parseSmallBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES });
  router.use((request, response, next) => {
    const upstreamUrl = getUpstreamUrl(request.originalUrl, request.method);
    if (upstreamUrl?.origin === 'https://api.soundcloud.com' && ['POST', 'PUT'].includes(request.method)) {
      next();
      return;
    }
    parseSmallBody(request, response, next);
  });

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

    const streamedTrackBody =
      upstreamUrl.origin === 'https://api.soundcloud.com' && ['POST', 'PUT'].includes(request.method);
    const declaredLength = request.header('content-length');
    if (streamedTrackBody && declaredLength && Number(declaredLength) > MAX_SOUND_CLOUD_TRACK_BYTES) {
      response.status(413).json({ error: 'SoundCloud track request exceeded the relay limit.' });
      return;
    }

    let bodyStream: Transform | undefined;
    let requestTooLarge = false;
    const aborted = new AbortController();
    const abortUpstream = () => aborted.abort();
    if (streamedTrackBody) {
      if (declaredLength) headers.set('content-length', declaredLength);
      let receivedBytes = 0;
      bodyStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_SOUND_CLOUD_TRACK_BYTES) {
            requestTooLarge = true;
            callback(new Error('SoundCloud track request exceeded the relay limit.'));
            return;
          }
          callback(null, chunk);
        },
      });
      bodyStream.on('error', abortUpstream);
      request.on('aborted', abortUpstream);
      request.pipe(bodyStream);
    }

    try {
      const options: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        body: streamedTrackBody
          ? (bodyStream as unknown as RequestInit['body'])
          : request.method === 'GET'
          ? undefined
          : new Uint8Array(request.body || Buffer.alloc(0)),
        redirect: 'manual',
        signal: streamedTrackBody
          ? AbortSignal.any([AbortSignal.timeout(SOUND_CLOUD_TRACK_TIMEOUT_MS), aborted.signal])
          : AbortSignal.timeout(20_000),
      };
      if (streamedTrackBody) options.duplex = 'half';
      const upstream = await fetchUpstream(upstreamUrl, options);

      const body = await readBoundedResponseBody(upstream, getResponseBodyLimit(upstreamUrl));
      if (!body) {
        response.status(502).json({ error: 'Provider response exceeded the relay limit.' });
        return;
      }

      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.status(upstream.status).send(body);
    } catch {
      bodyStream?.destroy();
      response.status(requestTooLarge ? 413 : 502).json({
        error: requestTooLarge
          ? 'SoundCloud track request exceeded the relay limit.'
          : 'Provider relay could not reach the upstream service.',
      });
    } finally {
      request.removeListener('aborted', abortUpstream);
    }
  });

  router.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error && error.status === 413 ? 413 : 400;
    response
      .status(status)
      .json({ error: status === 413 ? 'Provider request exceeded the relay limit.' : 'Invalid provider request.' });
  });

  return router;
};
