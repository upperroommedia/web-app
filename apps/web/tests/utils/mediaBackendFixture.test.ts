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
      uid: 'playwright-e2e',
      email: 'syntheticmedia-uploader@example.test',
      photoURL: null,
      displayName: 'Media Fixture Uploader',
      role: 'uploader',
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
      await lookup.handle(request(['playwright-e2e']) as unknown as Route);
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
