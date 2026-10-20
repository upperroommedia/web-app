import {
  createHetznerAcquisitionClient,
  createHetznerAcquisitionTransport,
  youtubeAcquisitionId,
} from '../../../process-audio/src/temporal/hetzner-acquisition';
import type { MediaJobRef } from '../../../process-audio/src/temporal/types';
const mockGetHeaders = jest.fn(async (_audience: string) => new Headers({ authorization: 'Bearer synthetic-test' }));
const mockGetClient = jest.fn(async (_audience: string) => ({ getRequestHeaders: mockGetHeaders }));
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
jest.mock('google-auth-library', () => ({ GoogleAuth: jest.fn(() => ({ getIdTokenClient: mockGetClient })) }));

const ref: MediaJobRef = {
  projectId: 'urm-app-staging',
  jobId: 'audio-one',
  sermonId: 'sermon-one',
  revision: 1,
  requestVersion: 'a'.repeat(16),
};
const artifact = {
  path: `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-one.m4a`,
  generation: '123',
  bytes: 1234,
  crc32c: 'AAAAAA==',
};
const state = (status: string, extra = {}) => ({ status, operationId: youtubeAcquisitionId(ref), ...extra });
const setup = (responses: Array<unknown | Error>) => {
  const request = jest.fn(
    async (_method: 'GET' | 'POST', _request: { operationId: string; ref: MediaJobRef }, _signal: AbortSignal) => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  );
  const heartbeat = jest.fn();
  const client = createHetznerAcquisitionClient({ request, heartbeat, wait: async () => undefined, maxPolls: 4 });
  return { request, heartbeat, client };
};
test('an existing operation is polled and adopted without repeating start', async () => {
  const { request, client, heartbeat } = setup([state('running'), state('ready', { artifact })]);
  await expect(client.acquire(ref, new AbortController().signal)).resolves.toEqual({ kind: 'source', artifact });
  expect(request.mock.calls.map((call) => call[0])).toEqual(['GET', 'GET']);
  expect(heartbeat).toHaveBeenCalledTimes(2);
});
test('lost start acknowledgement is reconciled with the SAME operation, never blind resubmitted', async () => {
  const { request, client } = setup([
    state('missing'),
    new Error('private provider URL'),
    state('running'),
    state('ready', { artifact }),
  ]);
  await expect(client.acquire(ref, new AbortController().signal)).resolves.toEqual({ kind: 'source', artifact });
  expect(request.mock.calls.map((call) => call[0])).toEqual(['GET', 'POST', 'GET', 'GET']);
  expect(request.mock.calls.every((call) => call[1].operationId === youtubeAcquisitionId(ref))).toBe(true);
});
test('unconfirmed start never produces another POST or false completion', async () => {
  const { request, client } = setup([state('missing'), new Error('lost acknowledgement'), state('missing')]);
  await expect(client.acquire(ref, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_ACK_UNKNOWN',
  });
  expect(request.mock.calls.filter((call) => call[0] === 'POST')).toHaveLength(1);
});
test('a restarted caller adopts the persisted source without starting work', async () => {
  const { client, request } = setup([state('ready', { artifact })]);
  await expect(client.acquire({ ...ref }, new AbortController().signal)).resolves.toEqual({ kind: 'source', artifact });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('GET');
});
test('preserves the existing source-format binary suffix fallback pending actual media validation', async () => {
  const source = { ...artifact, path: artifact.path.replace('.m4a', '.bin') };
  const { client } = setup([state('ready', { artifact: source })]);
  await expect(client.acquire(ref, new AbortController().signal)).resolves.toEqual({
    kind: 'source',
    artifact: source,
  });
});
test('cancellation stops polling without claiming the remote process was cancelled', async () => {
  const controller = new AbortController();
  const request = jest.fn(
    async (_method: 'GET' | 'POST', _request: { operationId: string; ref: MediaJobRef }, _signal: AbortSignal) =>
      state('running')
  );
  const client = createHetznerAcquisitionClient({
    request,
    heartbeat: () => controller.abort(),
    wait: async () => undefined,
    maxPolls: 2,
  });
  await expect(client.acquire(ref, controller.signal)).rejects.toBeDefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('GET');
});
test.each([
  'waiting_auth',
  'waiting_archive',
  'restricted',
  'cancelled',
  'superseded',
  'deleted',
  'completed',
  'source_available',
])('preserves safe outcome %s without raw failure payloads', async (status) => {
  const { client } = setup([state(status)]);
  await expect(client.acquire(ref, new AbortController().signal)).resolves.toEqual(
    status === 'waiting_auth' ? { kind: status, recoveryGeneration: null } : { kind: status }
  );
});
test.each([
  state('ready', { artifact: { ...artifact, path: 'https://private.example/?token=secret' } }),
  state('ready', { artifact: { ...artifact, path: artifact.path.replace('sermon-one', 'other') } }),
  state('ready', { artifact: { ...artifact, generation: 'latest' } }),
  state('ready', { artifact: { ...artifact, bytes: 0 } }),
  { status: 'ready', operationId: 'other', artifact },
  state('ready', { artifact, privateUrl: 'do not retain' }),
])('rejects an invalid or mismatched private artifact response', async (response) => {
  const { client } = setup([response]);
  await expect(client.acquire(ref, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_PROTOCOL',
  });
});
test('bounded polling never mistakes a running helper for a complete source', async () => {
  const { client, request } = setup(Array.from({ length: 4 }, () => state('running')));
  await expect(client.acquire(ref, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_PENDING',
  });
  expect(request).toHaveBeenCalledTimes(4);
});
test('operation identity binds all immutable reference fields and rejects production', () => {
  expect(youtubeAcquisitionId({ ...ref })).toBe(youtubeAcquisitionId(ref));
  expect(youtubeAcquisitionId({ ...ref, revision: 2 })).not.toBe(youtubeAcquisitionId(ref));
  expect(() => youtubeAcquisitionId({ ...ref, projectId: 'urm-app' })).toThrow();
  expect(() => youtubeAcquisitionId({ ...ref, sermonId: '../other' })).toThrow();
  const malformed = JSON.parse(JSON.stringify(ref));
  malformed.jobId = 12;
  expect(() => youtubeAcquisitionId(malformed)).toThrow();
});
test('transport fixes OIDC audience, sends once without redirects and never calls legacy processing', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(state('running')));
  const transport = createHetznerAcquisitionTransport(ref.projectId);
  const request = { operationId: youtubeAcquisitionId(ref), ref };
  await expect(transport('POST', request, new AbortController().signal)).resolves.toEqual(state('running'));
  expect(mockGetClient).toHaveBeenLastCalledWith('https://yt-worker-staging.upperroommedia.org');
  expect(mockGetHeaders).toHaveBeenLastCalledWith('https://yt-worker-staging.upperroommedia.org');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe(
    `https://yt-worker-staging.upperroommedia.org/internal/temporal/youtube/acquisitions/${request.operationId}`
  );
  expect(options?.method).toBe('POST');
  expect(options?.body).toBe(JSON.stringify(request));
  expect(options?.redirect).toBe('error');
  expect(() => createHetznerAcquisitionTransport('urm-app')).toThrow();
});
test('transport failures cannot leak raw request or provider messages into history', async () => {
  jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('https://private.example/?token=secret'));
  const transport = createHetznerAcquisitionTransport(ref.projectId);
  await expect(
    transport('POST', { operationId: youtubeAcquisitionId(ref), ref }, new AbortController().signal)
  ).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_UNAVAILABLE',
    message: 'YouTube acquisition is awaiting a verified source result.',
  });
});
test.each(['client', 'headers'])('deadline includes stalled authentication setup: %s', async (phase) => {
  jest.useFakeTimers();
  if (phase === 'client') mockGetClient.mockImplementationOnce(() => new Promise(() => undefined));
  else mockGetHeaders.mockImplementationOnce(() => new Promise(() => undefined));
  const fetcher = jest.spyOn(globalThis, 'fetch');
  const transport = createHetznerAcquisitionTransport(ref.projectId);
  const result = expect(
    transport('POST', { operationId: youtubeAcquisitionId(ref), ref }, new AbortController().signal)
  ).rejects.toMatchObject({ type: 'YOUTUBE_ACQUISITION_UNAVAILABLE' });
  await jest.advanceTimersByTimeAsync(10001);
  await result;
  expect(fetcher).not.toHaveBeenCalled();
});
test('late authentication completion cannot POST after caller cancellation', async () => {
  let finish!: () => void;
  mockGetClient.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ getRequestHeaders: mockGetHeaders });
      })
  );
  const fetcher = jest.spyOn(globalThis, 'fetch');
  const controller = new AbortController();
  const transport = createHetznerAcquisitionTransport(ref.projectId);
  const result = expect(
    transport('POST', { operationId: youtubeAcquisitionId(ref), ref }, controller.signal)
  ).rejects.toBeDefined();
  controller.abort();
  await result;
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
});
test('response reading is bounded before JSON parsing', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(16385)));
  const transport = createHetznerAcquisitionTransport(ref.projectId);
  await expect(
    transport('GET', { operationId: youtubeAcquisitionId(ref), ref }, new AbortController().signal)
  ).rejects.toMatchObject({ type: 'YOUTUBE_ACQUISITION_UNAVAILABLE' });
});
test.each([20 * 1024 ** 3, 20 * 1024 ** 3 + 1])('remote source preserves byte ceiling: %s', async (bytes) => {
  const { client } = setup([state('ready', { artifact: { ...artifact, bytes } })]);
  const result = client.acquire(ref, new AbortController().signal);
  if (bytes === 20 * 1024 ** 3) await expect(result).resolves.toMatchObject({ kind: 'source' });
  else await expect(result).rejects.toMatchObject({ type: 'YOUTUBE_ACQUISITION_PROTOCOL' });
});
test('transport refuses a static service-account credential override', () => {
  const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/not-a-native-identity.json';
    expect(() => createHetznerAcquisitionTransport(ref.projectId)).toThrow();
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
  }
});

test('an unmeasured remote source reports verified bytes and CRC rather than claiming duration', async () => {
  const locator = { path: artifact.path, generation: artifact.generation, bytes: 1234, crc32c: 'AAAAAA==' };
  const { client } = setup([state('ready', { artifact: locator })]);
  await expect(client.acquire(ref, new AbortController().signal)).resolves.toEqual({
    kind: 'source',
    artifact: locator,
  });
});

test.each([
  { ...artifact, duration: 100 },
  { ...artifact, bytes: 0 },
  { ...artifact, bytes: -1 },
  { ...artifact, bytes: 1.5 },
  { ...artifact, bytes: Infinity },
  { ...artifact, crc32c: 'invalid' },
  { ...artifact, crc32c: undefined },
])('rejects unverified or duration-bearing remote byte receipts', async (locator) => {
  const { client } = setup([state('ready', { artifact: locator })]);
  await expect(client.acquire(ref, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_PROTOCOL',
  });
});

test('an existing-source signal cannot smuggle an unmeasured artifact or claim job completion', async () => {
  const { client } = setup([state('source_available', { artifact })]);
  await expect(client.acquire(ref, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_PROTOCOL',
  });
});
