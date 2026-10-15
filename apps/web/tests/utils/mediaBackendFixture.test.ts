import { createHash } from 'node:crypto';
import { MEDIA_FIXTURE_UPLOADER } from '../helpers/mediaFixtureIdentity';
import { routePlayableAudio } from '../helpers/ownedAudioFixture';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import {
  MEDIA_BUNDLE_QUERIES,
  parseMediaBackendFixture,
  installMediaBackendFixtures,
} from '../helpers/mediaBackendFixture';
jest.mock('../helpers/providerStatusFixture', () => ({ installMediaProviderStatusFixture: jest.fn(async () => {}) }));
const fixture = () => ({
  schemaVersion: 1,
  projectId: 'demo-temporal-ci',
  bundles: Object.fromEntries(
    Object.entries(MEDIA_BUNDLE_QUERIES).map(([name, namedQuery]) => [
      name,
      { namedQuery, bodyBase64: Buffer.from('transport-test-only-not-an-SDK-bundle').toString('base64'), timestamp: 1 },
    ])
  ),
  users: [
    {
      uid: MEDIA_FIXTURE_UPLOADER.uid,
      email: MEDIA_FIXTURE_UPLOADER.email,
      photoURL: null,
      displayName: MEDIA_FIXTURE_UPLOADER.displayName,
      role: MEDIA_FIXTURE_UPLOADER.role,
      refreshToken: '',
      phoneNumber: null,
      tenantId: null,
      providerData: [],
      firstName: '',
      lastName: '',
      emailVerified: false,
      isAnonymous: false,
      metadata: {},
      providerId: '',
    },
  ],
});
describe('exact isolated media transport fixtures', () => {
  it('accepts only the six exact query identities and synthetic directory record', () => {
    expect(parseMediaBackendFixture(fixture()).bundles.createlatestlistbundle.namedQuery).toBe('latest-list-query');
    for (const value of [
      { ...fixture(), projectId: 'urm-app' },
      { ...fixture(), users: [{ ...fixture().users[0], refreshToken: 'real-token' }] },
      {
        ...fixture(),
        bundles: { ...fixture().bundles, unknown: { namedQuery: 'x', timestamp: 1, bodyBase64: 'eA==' } },
      },
    ])
      expect(() => parseMediaBackendFixture(value)).toThrow();
    const changed = fixture();
    changed.bundles.createlatestlistbundle.namedQuery = 'latest-latest-list-query';
    expect(() => parseMediaBackendFixture(changed)).toThrow();
  });
  it('roundtrips the shared strict identity and rejects the old spelling or any changed identity field', () => {
    const serialized = JSON.parse(JSON.stringify(fixture()));
    expect(parseMediaBackendFixture(serialized).users[0]).toMatchObject(MEDIA_FIXTURE_UPLOADER);
    for (const patch of [
      { email: 'syntheticmedia-uploader@example.test' },
      { email: 'different@example.test' },
      { uid: 'different-uploader' },
      { displayName: 'Different uploader' },
      { role: 'admin' },
    ])
      expect(() => parseMediaBackendFixture({ ...fixture(), users: [{ ...fixture().users[0], ...patch }] })).toThrow(
        'Invalid synthetic uploader'
      );
  });
  it('rejects malformed and oversized payload encodings', () => {
    for (const bodyBase64 of ['', 'not base64', Buffer.alloc(1024 * 1024 + 1).toString('base64')]) {
      const value = fixture();
      value.bundles.createtopicbundle.bodyBase64 = bodyBase64;
      expect(() => parseMediaBackendFixture(value)).toThrow();
    }
  });
  it('registers only exact demo GETs and the authenticated known-user lookup', async () => {
    const keys = [
      'URM_MEDIA_BROWSER_STATUS_FIXTURE',
      'GCLOUD_PROJECT',
      'PLAYWRIGHT_BASE_URL',
      'NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT',
      'URM_MEDIA_BROWSER_BUNDLE_FIXTURES_FILE',
    ] as const;
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const dir = await mkdtemp(join(tmpdir(), 'media-transport-'));
    try {
      const file = join(dir, 'fixture.json');
      await writeFile(file, JSON.stringify(fixture()), { mode: 0o600 });
      Object.assign(process.env, {
        URM_MEDIA_BROWSER_STATUS_FIXTURE: 'true',
        GCLOUD_PROJECT: 'demo-temporal-ci',
        PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3004',
        NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT: '5011',
        URM_MEDIA_BROWSER_BUNDLE_FIXTURES_FILE: file,
      });
      const routes: Array<{ match: (url: URL) => boolean; handle: (route: Route) => Promise<void> }> = [];
      const page = {
        route: async (match: (url: URL) => boolean, handle: (route: Route) => Promise<void>) => {
          routes.push({ match, handle });
        },
      } as unknown as Page;
      await installMediaBackendFixtures(page);
      expect(routes).toHaveLength(7);
      expect(
        routes.every(
          (route) => !route.match(new URL('https://us-central1-urm-app.cloudfunctions.net/createtopicbundle'))
        )
      ).toBe(true);
      const topic = routes.find((route) =>
        route.match(new URL('http://127.0.0.1:5001/demo-temporal-ci/us-central1/createtopicbundle'))
      )!;
      const fulfill = jest.fn();
      await topic.handle({
        request: () => ({ method: () => 'GET', headers: () => ({ origin: 'http://127.0.0.1:3004' }) }),
        fulfill,
      } as unknown as Route);
      expect(fulfill).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'application/octet-stream',
          body: Buffer.from('transport-test-only-not-an-SDK-bundle'),
        })
      );
      const lookup = routes.find((route) =>
        route.match(new URL('http://127.0.0.1:5011/demo-temporal-ci/us-central1/getusersbyids'))
      )!;
      const request = (uids: string[]) => ({
        request: () => ({
          method: () => 'POST',
          headers: () => ({ origin: 'http://127.0.0.1:3004', authorization: 'Bearer synthetic-test-only' }),
          postDataJSON: () => ({ data: { uids } }),
        }),
        fulfill,
      });
      await lookup.handle(request([MEDIA_FIXTURE_UPLOADER.uid]) as unknown as Route);
      expect(fulfill).toHaveBeenLastCalledWith(
        expect.objectContaining({ json: { result: { status: 'success', data: fixture().users } } })
      );
      await expect(lookup.handle(request(['unknown-user']) as unknown as Route)).rejects.toThrow(
        'Unexpected demo uploader'
      );
      process.env.GCLOUD_PROJECT = 'urm-app';
      await expect(installMediaBackendFixtures(page)).rejects.toThrow('isolated demo');
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('owned media read-only route', () => {
  it('matches only the owned loopback object and blocks every non-read method', async () => {
    let match!: (url: URL) => boolean;
    let handle!: (route: Route) => Promise<void>;
    const page = {
      route: async (predicate: typeof match, handler: typeof handle) => {
        match = predicate;
        handle = handler;
      },
    } as unknown as Page;
    await routePlayableAudio(page, 'owned-sermon');
    const project = process.env.GCLOUD_PROJECT ?? 'urm-app';
    const port = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT ?? '9199';
    const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${project}.appspot.com`;
    const url = `http://127.0.0.1:${port}/v0/b/${bucket}/o/intro-outro-sermons%2Fowned-sermon`;
    expect(match(new URL(url))).toBe(true);
    expect(match(new URL(url.replace('owned-sermon', 'owned-sermon-other')))).toBe(false);
    expect(match(new URL(url.replace(`http://127.0.0.1:${port}`, 'https://storage.googleapis.com')))).toBe(false);
    const fulfill = jest.fn();
    const abort = jest.fn(async () => {});
    const request = (method: string, target = url) =>
      ({
        request: () => ({
          method: () => method,
          url: () => target,
          headers: () => ({ origin: 'http://127.0.0.1:3004' }),
        }),
        fulfill,
        abort,
      } as unknown as Route);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(handle(request(method))).rejects.toThrow('non-read methods');
      expect(abort).toHaveBeenLastCalledWith('blockedbyclient');
    }
    expect(fulfill).not.toHaveBeenCalled();
    await handle(request('HEAD'));
    expect(fulfill).toHaveBeenLastCalledWith(expect.objectContaining({ body: '', contentType: 'application/json' }));
    await handle(request('HEAD', url + '?alt=media'));
    expect(fulfill).toHaveBeenLastCalledWith(expect.objectContaining({ body: '', contentType: 'audio/wav' }));
    await handle(request('GET', url + '?alt=media'));
    const response = fulfill.mock.calls.at(-1)![0];
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.subarray(0, 4).toString()).toBe('RIFF');
  });
});

// Exercise the actual registered route without launching a browser or a server.
async function ownedMediaRoute() {
  let handler!: (route: Route) => Promise<void>;
  const fulfill = jest.fn(async (_response: Parameters<Route['fulfill']>[0]) => {});
  const abort = jest.fn(async () => {});
  await routePlayableAudio(
    {
      route: async (_predicate: unknown, callback: typeof handler) => {
        handler = callback;
      },
    } as unknown as Page,
    'range-sermon'
  );
  const project = process.env.GCLOUD_PROJECT ?? 'urm-app';
  const port = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT ?? '9199';
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${project}.appspot.com`;
  const url = `http://127.0.0.1:${port}/v0/b/${bucket}/o/intro-outro-sermons%2Frange-sermon?alt=media`;
  return async (range?: string, method = 'GET') => {
    await handler({
      request: () => ({
        method: () => method,
        url: () => url,
        headers: () => ({ origin: 'http://127.0.0.1:3004', ...(range === undefined ? {} : { range }) }),
      }),
      fulfill,
      abort,
    } as unknown as Route);
    return fulfill.mock.calls.at(-1)![0]!;
  };
}

describe('owned WAV HTTP single-range representation', () => {
  it('preserves the original full WAV bytes, PCM duration and advertised complete length', async () => {
    const serve = await ownedMediaRoute();
    const response = await serve();
    expect(response.status).toBe(200);
    const body = response.body as Buffer;
    expect(body.length).toBe(480044);
    // SHA256 of the original WAV preserved in the failing CI trace, independent of range handling.
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      'd9143b1f28e67d714a28c2dc3f324192d9a68862940f03c52cb93d9a5ee39778'
    );
    expect(body.subarray(0, 4).toString()).toBe('RIFF');
    expect(body.readUInt32LE(24)).toBe(8000);
    expect(body.readUInt32LE(40) / body.readUInt32LE(28)).toBe(60);
    expect(response.headers).toEqual(expect.objectContaining({ 'content-length': '480044', 'accept-ranges': 'bytes' }));
    expect(response.headers).not.toHaveProperty('content-range');
  });

  it.each([
    ['bytes=0-', 0, 480043],
    ['bytes=0-0', 0, 0],
    ['bytes=44-79', 44, 79],
    ['bytes=480040-', 480040, 480043],
    ['bytes=480040-999999999999999999999999', 480040, 480043],
    ['bytes=-4', 480040, 480043],
    ['bytes=-999999999999999999999999', 0, 480043],
    ['BYTES= 00044-00079 ', 44, 79],
  ] as const)('returns an exact inclusive byte slice for %s', async (range, start, end) => {
    const serve = await ownedMediaRoute();
    const full = await serve();
    const response = await serve(range);
    expect(response.status).toBe(206);
    expect(response.body).toEqual((full.body as Buffer).subarray(start, end + 1));
    expect(response.headers).toEqual(
      expect.objectContaining({
        'content-range': `bytes ${start}-${end}/480044`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
      })
    );
  });

  it.each(['bytes=480044-', 'bytes=999999999999999999999999-', 'bytes=999999-9999999', 'bytes=-0'])(
    'reports an unsatisfiable range without a partial or full body: %s',
    async (range) => {
      const response = await (await ownedMediaRoute())(range);
      expect(response.status).toBe(416);
      expect(response.headers).toEqual(
        expect.objectContaining({ 'content-range': 'bytes */480044', 'content-length': '0', 'accept-ranges': 'bytes' })
      );
      expect(response.body).toBe('');
    }
  );

  it.each([
    'bytes=40-39',
    'bytes=999999999999999999999999-999999999999999999999998',
    'bytes=-',
    'bytes=abc-def',
    'bytes=0--1',
    'bytes=0.5-1',
    'bytes =0-1',
    'garbage',
    '',
  ])('rejects a malformed single-range request deterministically: %s', async (range) => {
    const response = await (await ownedMediaRoute())(range);
    expect(response.status).toBe(400);
    expect(response.headers).not.toHaveProperty('content-range');
    expect(response.headers).toHaveProperty('content-length', '0');
    expect(response.body).toBe('');
  });

  it.each(['items=0-4', 'bytes=0-1,4-5'])(
    'ignores unsupported units or multipart ranges as a complete GET: %s',
    async (range) => {
      const serve = await ownedMediaRoute();
      const full = await serve();
      const response = await serve(range);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(full.body);
      expect(response.headers).toEqual(full.headers);
    }
  );

  it.each([undefined, 'bytes=44-79', 'bytes=999999999999999999999999-', 'bytes=bad'])(
    'HEAD ignores Range and advertises GET representation length without a body: %s',
    async (range) => {
      const serve = await ownedMediaRoute();
      const full = await serve();
      const response = await serve(range, 'HEAD');
      expect(response.status).toBe(200);
      expect(response.headers).toEqual(full.headers);
      expect(response.body).toBe('');
    }
  );
});
