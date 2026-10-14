import { Readable } from 'node:stream';
let mockProject = 'urm-app-staging';
let mockMarker: any;
const mockWire = jest.fn(),
  mockEngine = jest.fn(),
  mockUpload = jest.fn(),
  mockProbe = jest.fn();
const mockToken = jest.fn(),
  mockExchange = jest.fn(),
  mockCreate = jest.fn(),
  mockUpdate = jest.fn();
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    ...actual,
    __esModule: true,
    default: Object.assign(
      jest.fn((...args: any[]) => mockWire(...args)),
      actual.default,
      { request: (...args: any[]) => mockWire(...args) }
    ),
  };
});
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: mockProject } }),
    firestore: () => ({ doc: () => ({ get: async () => ({ data: () => mockMarker }) }) }),
  },
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => undefined,
  getPublishingSourceStepIds: () => [],
}));
jest.mock('./service', () => ({
  handleSandboxRequest: (...args: any[]) => mockEngine(...args),
  uploadSandboxAllocation: (...args: any[]) => mockUpload(...args),
  probeSandboxMedia: (...args: any[]) => mockProbe(...args),
  createSandboxSoundCloudTrack: (...args: any[]) => mockCreate(...args),
  updateSandboxSoundCloudTrack: (...args: any[]) => mockUpdate(...args),
}));
jest.mock('./oauth', () => ({
  verifySandboxSoundCloudAccessToken: (...args: any[]) => mockToken(...args),
  exchangeSandboxSoundCloudToken: (...args: any[]) => mockExchange(...args),
}));
import http, { withSandboxRequestContext, probeProviderAudioUrl, sandboxTrackMutation } from './http';
import { STAGING_SANDBOX_PROFILE } from './profile';
const headers = { Authorization: 'Bearer provider-sandbox:urm-app-staging-publishing-v1:subsplash' };
const scope = { jobId: 'job', sourceStepIds: ['upload'] };
beforeEach(() => {
  mockProject = 'urm-app-staging';
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  mockMarker = {
    state: 'ready',
    profile: STAGING_SANDBOX_PROFILE,
    catalogImportId: 'import',
    sourceDigest: 'a'.repeat(64),
    resourceCount: 1,
  };
  for (const mock of [mockWire, mockEngine, mockUpload, mockProbe, mockToken, mockExchange, mockCreate, mockUpdate])
    mock.mockReset();
  mockWire.mockRejectedValue(new Error('LIVE NETWORK FORBIDDEN IN TEST'));
  mockEngine.mockResolvedValue({ status: 200, data: { id: 'simulated' }, headers: {} });
  mockToken.mockResolvedValue({ id: 9000000000001 });
});
afterEach(() => {
  delete process.env.STAGING_PROVIDER_MODE;
  jest.restoreAllMocks();
});
test.each([undefined, 'live', 'typo'])('staging mode %s never invokes a real transport', async (mode) => {
  if (mode === undefined) delete process.env.STAGING_PROVIDER_MODE;
  else process.env.STAGING_PROVIDER_MODE = mode;
  await expect(http.get('https://core.subsplash.com/builder/v1/lists', { headers })).rejects.toThrow();
  expect(mockWire).not.toHaveBeenCalled();
  expect(mockEngine).not.toHaveBeenCalled();
});
test('production delegates the exact configuration and result unchanged', async () => {
  mockProject = 'urm-app';
  delete process.env.STAGING_PROVIDER_MODE;
  const config = { url: 'https://core.subsplash.com/builder/v1/lists', method: 'GET' as const, headers },
    result = { production: true };
  mockWire.mockResolvedValue(result);
  expect(await http(config)).toBe(result);
  expect(mockWire).toHaveBeenCalledWith(config);
});
test.each(['postForm', 'putForm', 'patchForm'] as const)(
  'production preserves %s serialization semantics',
  async (method) => {
    mockProject = 'urm-app';
    delete process.env.STAGING_PROVIDER_MODE;
    const raw = jest.requireMock('axios').default;
    const result = { production: method };
    const spy = jest.spyOn(raw, method).mockResolvedValue(result);
    const body = { title: 'Original form value' },
      config = { timeout: 1234 };
    expect(await http[method]('https://api.soundcloud.com/tracks', body, config)).toBe(result);
    expect(spy).toHaveBeenCalledWith('https://api.soundcloud.com/tracks', body, config);
    expect(mockWire).not.toHaveBeenCalled();
    expect(mockEngine).not.toHaveBeenCalled();
  }
);
test('production cannot enable the staging profile', async () => {
  mockProject = 'urm-app';
  await expect(http.get('https://api.soundcloud.com/me')).rejects.toThrow();
  expect(mockWire).not.toHaveBeenCalled();
});
test('owned resource reads use simulator and preserve caller parameters', async () => {
  const params = { 'page[size]': 10 };
  const response = await http.get('https://core.subsplash.com/builder/v1/lists', { headers, params });
  expect(response.data.id).toBe('simulated');
  expect(mockEngine).toHaveBeenCalledWith(
    STAGING_SANDBOX_PROFILE,
    expect.objectContaining({ provider: 'subsplash', method: 'GET', params })
  );
  expect(mockWire).not.toHaveBeenCalled();
});
test('catalog absence cannot fall back to live provider reads', async () => {
  mockMarker = undefined;
  await expect(http.get('https://core.subsplash.com/builder/v1/lists', { headers })).rejects.toThrow();
  expect(mockEngine).not.toHaveBeenCalled();
  expect(mockWire).not.toHaveBeenCalled();
});
test('mutation requires trusted durable context and forwards actual step scope', async () => {
  await expect(http.post('https://core.subsplash.com/builder/v1/lists', {}, { headers })).rejects.toThrow(
    'trusted durable'
  );
  await withSandboxRequestContext(scope, () =>
    http.post('https://core.subsplash.com/builder/v1/lists', {}, { headers })
  );
  expect(mockEngine).toHaveBeenCalledTimes(1);
  expect(mockEngine.mock.calls[0][1].context).toEqual(scope);
  expect(mockWire).not.toHaveBeenCalled();
});
test('a real provider cached credential is not sandbox authority', async () => {
  await expect(
    http.get('https://core.subsplash.com/builder/v1/lists', { headers: { Authorization: 'Bearer real-cached-token' } })
  ).rejects.toThrow('Synthetic Subsplash');
  expect(mockEngine).not.toHaveBeenCalled();
  expect(mockWire).not.toHaveBeenCalled();
});
test.each([
  'https://yt-worker-staging.upperroommedia.org/internal/provider-relay/subsplash/files/v1/images',
  'https://example.com/asset',
  'https://core.subsplash.com.evil.invalid/files/v1/images',
])('foreign origin %s is rejected without a network request', async (url) => {
  await expect(http.get(url, { headers })).rejects.toThrow();
  expect(mockWire).not.toHaveBeenCalled();
});
test('unknown engine routes fail closed rather than use live transport', async () => {
  mockEngine.mockRejectedValue(new Error('Unsupported provider route'));
  await expect(http.get('https://core.subsplash.com/unknown', { headers })).rejects.toThrow('Unsupported');
  expect(mockWire).not.toHaveBeenCalled();
});
test('SoundCloud /me and OAuth grants use only synthetic auth helpers', async () => {
  mockExchange.mockResolvedValue({ access_token: 'synthetic' });
  await http.post('https://secure.soundcloud.com/oauth/token', 'grant_type=refresh_token&refresh_token=synthetic');
  await http.get('https://api.soundcloud.com/me', { headers: { Authorization: 'OAuth synthetic' } });
  expect(mockExchange).toHaveBeenCalledTimes(1);
  expect(mockToken).toHaveBeenCalledWith(STAGING_SANDBOX_PROFILE, 'synthetic');
  expect(mockEngine).not.toHaveBeenCalled();
  expect(mockWire).not.toHaveBeenCalled();
});
test('virtual image bytes stay streaming and are bounded by allocation adapter', async () => {
  const stream = Readable.from([Buffer.from('image')]);
  mockUpload.mockResolvedValue({ status: 200, data: undefined, headers: {} });
  await withSandboxRequestContext(scope, () =>
    http.put('https://provider-sandbox.invalid/urm-app-staging-publishing-v1/upload/asset', stream, {
      headers: { 'Content-Type': 'image/png' },
    })
  );
  expect(mockUpload.mock.calls[0][2]).toBe(stream);
  expect(mockUpload.mock.calls[0][3]).toEqual({ contentType: 'image/png', maxBytes: 25 * 1024 * 1024 });
  expect(mockWire).not.toHaveBeenCalled();
});
test('virtual readiness uses bounded actual asset probe and never native fetch', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NATIVE NETWORK FORBIDDEN'));
  mockProbe.mockResolvedValue({ ok: true, size: 99, contentType: 'audio/mpeg', sha256: 'a'.repeat(64) });
  expect(
    await probeProviderAudioUrl(
      'https://provider-sandbox.invalid/urm-app-staging-publishing-v1/media/audios/asset',
      'ignored'
    )
  ).toBe(true);
  expect(mockProbe.mock.calls[0][2]).toEqual({ maxBytes: 1024 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(mockWire).not.toHaveBeenCalled();
  await expect(probeProviderAudioUrl('https://core.subsplash.com/real-audio', 'ignored')).rejects.toThrow(
    'owned virtual'
  );
});
test('structured track upload validates synthetic auth and returns response body', async () => {
  const body = { id: '8000000000000', urn: 'soundcloud:tracks:8000000000000' };
  mockCreate.mockResolvedValue({ status: 201, data: body, headers: {} });
  expect(
    await withSandboxRequestContext(scope, () =>
      sandboxTrackMutation(
        {
          metadata: { title: 'test' },
          audio: { bucket: 'urm-app-staging.firebasestorage.app', path: 'audio', generation: '1' },
        },
        'synthetic'
      )
    )
  ).toBe(body);
  expect(mockToken).toHaveBeenCalledWith(STAGING_SANDBOX_PROFILE, 'synthetic');
  expect(mockCreate.mock.calls[0][2]).toEqual(scope);
  expect(mockWire).not.toHaveBeenCalled();
});

test('a forged environment project cannot override the actual staging app', async () => {
  delete process.env.STAGING_PROVIDER_MODE;
  const before = process.env.GCLOUD_PROJECT;
  process.env.GCLOUD_PROJECT = 'urm-app';
  try {
    await expect(http.get('https://api.soundcloud.com/me')).rejects.toThrow();
  } finally {
    if (before === undefined) delete process.env.GCLOUD_PROJECT;
    else process.env.GCLOUD_PROJECT = before;
  }
  expect(mockWire).not.toHaveBeenCalled();
});
test('only an exact staging Storage input may use ordinary HTTPS, without provider headers or redirects', async () => {
  mockWire.mockResolvedValue({ data: 'actual-stage-input' });
  const url =
    'https://firebasestorage.googleapis.com/v0/b/urm-app-staging.firebasestorage.app/o/images%2Finput?alt=media';
  expect((await http.get(url, { headers })).data).toBe('actual-stage-input');
  expect(mockWire).toHaveBeenCalledWith(expect.objectContaining({ url, headers: {}, maxRedirects: 0 }));
  mockWire.mockClear();
  for (const url of [
    'https://firebasestorage.googleapis.com/v0/b/urm-app.appspot.com/o/file?alt=media',
    'https://firebasestorage.googleapis.com:444/v0/b/urm-app-staging-images/o/file',
  ])
    await expect(http.get(url)).rejects.toThrow();
  expect(mockWire).not.toHaveBeenCalled();
});
