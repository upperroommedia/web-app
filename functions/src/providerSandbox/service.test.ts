import type { SandboxResource } from './types';
import { STAGING_SANDBOX_PROFILE } from './profile';
const resources = new Map<string, SandboxResource>();
let clock = 1000;
const key = (provider: string, family: string, id: string) => JSON.stringify([provider, family, id]);
jest.mock('./profile', () => ({
  STAGING_SANDBOX_PROFILE: {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    mode: 'sandbox',
    profileId: 'urm-app-staging-publishing-v1',
    version: 1,
    namespace: 'urm-app-staging-publishing-v1',
  },
}));
jest.mock('./store', () => ({
  assertSandboxAssetPreparation: jest.fn(async () => undefined),
  runSandboxOperation: async (_profile: unknown, _operation: unknown, work: Function) => {
    const staged = new Map(resources);
    const store = {
      now: clock,
      hasIdentity: async (provider: string, family: string, id: string) => staged.has(key(provider, family, id)),
      get: async (provider: string, family: string, id: string, optional: boolean) => {
        const value = staged.get(key(provider, family, id));
        if (!value || value.deleted) {
          if (optional) return undefined;
          throw Object.assign(new Error('not found'), { response: { status: 404 } });
        }
        return JSON.parse(JSON.stringify(value));
      },
      list: async (provider: string, family: string) =>
        [...staged.values()].filter((item) => item.provider === provider && item.family === family && !item.deleted),
      put: (item: SandboxResource) => staged.set(key(item.provider, item.family, item.id), item),
    };
    const result = await work(store, undefined);
    resources.clear();
    for (const [id, value] of staged) resources.set(id, value);
    return result;
  },
}));
jest.mock('./assets', () => ({
  copyStageAssetToSandbox: jest.fn(async (_profile, ref) => ({
    ...ref,
    path: '_providerSandbox/urm-app-staging-publishing-v1/media/copied',
    generation: '200',
  })),
  inspectStageAsset: jest.fn(async (_profile, ref) => ({
    ...ref,
    size: 176400,
    durationSeconds: 20,
    contentType: 'audio/wav',
    sha256: 'a'.repeat(64),
  })),
  resolveStageAsset: jest.fn(async () => ({
    bucket: 'urm-app-staging.firebasestorage.app',
    path: 'audio/test.wav',
    generation: '100',
  })),
  probeStageAsset: jest.fn(async () => ({ ok: true, contentType: 'audio/wav', size: 176400, sha256: 'b'.repeat(64) })),
  writeSandboxAllocation: jest.fn(),
}));
import { handleSandboxRequest, parseSandboxRoute, createSandboxSoundCloudTrack, probeSandboxMedia } from './service';
const request = (path: string, method = 'GET', data?: unknown) =>
  handleSandboxRequest(STAGING_SANDBOX_PROFILE, {
    provider: 'subsplash',
    method,
    url: `https://core.subsplash.com${path}`,
    data,
  });
const seed = (family: string, id: string, body: Record<string, unknown>) =>
  resources.set(key('subsplash', family, id), {
    schemaVersion: 1,
    provider: 'subsplash',
    family,
    id,
    revision: 1,
    deleted: false,
    body: { id, app_key: '9XTSHD', ...body },
    createdAtMillis: 1000,
    updatedAtMillis: 1000,
  });
beforeEach(() => {
  resources.clear();
  clock = 1000;
});
it.each([
  ['https://core.subsplash.com.evil.test/media/v1/media-items', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?filter[unknown]=x', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?filter[app_key]=prod', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?sort=unsupported', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?page[size]=100000', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?page[size]=10&page[size]=20', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items?include=unknown', 'GET'],
  ['https://core.subsplash.com/media/v1/media-items/a%2fb', 'GET'],
  ['https://core.subsplash.com/files/v1/audios/a', 'POST'],
  ['https://api.soundcloud.com/tracks', 'POST'],
])('rejects unsupported authority/protocol %s', (url, method) => {
  if (url === 'https://api.soundcloud.com/tracks')
    expect(() => parseSandboxRoute({ provider: 'soundcloud', url, method })).not.toThrow();
  else expect(() => parseSandboxRoute({ provider: 'subsplash', url, method })).toThrow();
});
it('creates distinct provider resources for identical POST retries, with no invented idempotency', async () => {
  const first = await request('/files/v1/audios', 'POST', { title: 'test' }),
    second = await request('/files/v1/audios', 'POST', { title: 'test' });
  expect(first.data.id).not.toBe(second.data.id);
  expect(first.status).toBe(201);
});
it('preserves ordered memberships and truthfully tombstones deleted rows', async () => {
  seed('lists', 'list', { _embedded: {} });
  seed('media-items', 'media', {});
  const result = await request('/builder/v1/lists/list', 'PATCH', {
    _embedded: { 'list-rows': [{ position: 1, type: 'media-item', _embedded: { 'media-item': { id: 'media' } } }] },
  });
  expect(result.data.list_rows_count).toBe(1);
  const rowId = result.data._embedded['list-rows'][0].id;
  await request('/builder/v1/lists/list', 'PATCH', { _embedded: { 'list-rows': [] } });
  expect(resources.get(key('subsplash', 'list-rows', rowId))?.deleted).toBe(true);
  expect((await request('/builder/v1/list-rows?filter[source_list]=list')).data.total).toBe(0);
});
it('rejects cross-list row adoption and unknown aliases without changing resources', async () => {
  seed('lists', 'list', { _embedded: {} });
  seed('lists', 'other', { _embedded: {} });
  seed('list-rows', 'foreign', { position: 1, _embedded: { 'source-list': { id: 'other' } } });
  await expect(
    request('/builder/v1/lists/list', 'PATCH', { _embedded: { 'list-rows': [{ id: 'foreign', position: 1 }] } })
  ).rejects.toThrow('another list');
  await expect(request('/files/v1/audios/unseeded')).rejects.toThrow('not found');
});
it('preserves filtering, pagination, totals, next links and order', async () => {
  seed('media-items', 'a', { position: 1, status: 'published', _embedded: { 'media-series': { id: 'series' } } });
  seed('media-items', 'b', { position: 2, status: 'published', _embedded: { 'media-series': { id: 'series' } } });
  seed('media-items', 'c', { position: 3, status: 'draft', _embedded: { 'media-series': { id: 'series' } } });
  const result = await request(
    '/media/v1/media-items?filter[media_series]=series&filter[status]=published&sort=-position&page[size]=1'
  );
  expect(result.data.total).toBe(2);
  expect(result.data._embedded['media-items'][0].id).toBe('b');
  expect(result.data._links.next.href).toContain('page%5Bnumber%5D=2');
});
it('transcodes genuine staged source, delays outputs and probes the exact virtual resource', async () => {
  seed('audios', 'audio', {});
  const created = await request('/transcoder/v1/jobs', 'POST', {
    file_name: 'https://storage.googleapis.com/urm-app-staging.firebasestorage.app/audio/test.wav',
    _embedded: { audio: { id: 'audio' } },
  });
  expect(created.data.status).toBe('processing');
  expect((await request('/files/v1/audios/audio')).data._embedded['audio-outputs']).toEqual([]);
  clock = 1600;
  expect((await request('/transcoder/v1/jobs/' + created.data.id)).data.status).toBe('complete');
  const output = (await request('/files/v1/audios/audio')).data._embedded['audio-outputs'][0];
  expect((await probeSandboxMedia(STAGING_SANDBOX_PROFILE, output._links.download.href, { maxBytes: 1024 })).ok).toBe(
    true
  );
  await expect(
    probeSandboxMedia(STAGING_SANDBOX_PROFILE, 'https://prod.example/audio', { maxBytes: 1024 })
  ).rejects.toThrow();
});
it('requires a seeded sandbox account and produces numeric track identifiers', async () => {
  const input = {
    metadata: { title: 'test' },
    audio: { bucket: 'urm-app-staging.firebasestorage.app', path: 'a.wav', generation: '100' },
  };
  await expect(createSandboxSoundCloudTrack(STAGING_SANDBOX_PROFILE, input)).rejects.toThrow('incomplete');
  resources.set(key('soundcloud', 'accounts', '9000000000001'), {
    schemaVersion: 1,
    provider: 'soundcloud',
    family: 'accounts',
    id: '9000000000001',
    revision: 1,
    deleted: false,
    body: { id: '9000000000001' },
    createdAtMillis: 1000,
    updatedAtMillis: 1000,
  });
  const result = await createSandboxSoundCloudTrack(STAGING_SANDBOX_PROFILE, input);
  expect(result.data.id).toMatch(/^[0-9]+$/);
  expect(result.data.user.id).toBe('9000000000001');
  expect(result.data.streamable).toBe(false);
});

it('supports the real cancellation inverse-reference queries without weakening unknown-filter rejection', async () => {
  seed('media-items', 'referenced', {
    tags: ['speaker:Sandbox Speaker'],
    _embedded: { audio: { id: 'source-audio' } },
  });
  seed('media-items', 'other', { tags: ['speaker:Other'], _embedded: { audio: { id: 'other-audio' } } });
  expect((await request('/media/v1/media-items?filter[audio]=source-audio&page[size]=1')).data.total).toBe(1);
  expect(
    (await request('/media/v1/media-items?filter[speaker]=Sandbox%20Speaker&page[size]=1')).data._embedded[
      'media-items'
    ][0].id
  ).toBe('referenced');
  expect((await request('/media/v1/media-items/referenced?include=audio,images,media-series,tags')).data.tags).toEqual([
    'speaker:Sandbox Speaker',
  ]);
  await expect(request('/files/v1/audios?filter[audio]=source-audio')).rejects.toThrow('unsupported');
});
it('supports the existing list scraper generated/type filters with truthful matching', async () => {
  seed('lists', 'manual', { type: 'standard', generated: false, _embedded: {} });
  seed('lists', 'generated', { type: 'standard', generated: true, _embedded: {} });
  expect(
    (await request('/builder/v1/lists?filter[generated]=false&filter[type]=standard')).data._embedded.lists.map(
      (row: any) => row.id
    )
  ).toEqual(['manual']);
  await expect(request('/builder/v1/lists?filter[generated]=maybe')).rejects.toThrow('generated');
});
