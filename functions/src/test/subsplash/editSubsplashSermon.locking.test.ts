import axios from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import editSubsplashSermon from '../../editSubsplashSermon';
import { authenticateSubsplash } from '../../subsplashUtils';

jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({
    url,
    token,
    method,
    data,
    headers: {},
  })),
}));

jest.mock('axios');
jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

type EditHandler = (request: {
  auth?: { token?: { role?: string } };
  data: Record<string, unknown>;
}) => Promise<unknown>;

const editHandler = editSubsplashSermon as unknown as EditHandler;
const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;

const buildValidPayload = () => ({
  operationKey: 'edit-op-1',
  subsplashId: 'media-item-123',
  title: 'Updated title',
  subtitle: 'Updated subtitle',
  speakers: [],
  topics: [],
  images: [],
  date: new Date(),
});

describe('editSubsplashSermon lock contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';
    mockAxios.mockResolvedValue({ data: { id: 'media-item-123' } } as never);
    mockAuthenticateSubsplash.mockResolvedValue('fake-token');
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());
  });

  it('throws HttpsError for unauthorized callers', async () => {
    await expect(editHandler({ data: buildValidPayload() })).rejects.toBeInstanceOf(HttpsError);
  });

  it('requires a non-empty operation key', async () => {
    await expect(
      editHandler({
        auth: { token: { role: 'admin' } },
        data: { ...buildValidPayload(), operationKey: '' },
      })
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it('wraps edit mutations with idempotency and media-item lock scope', async () => {
    await editHandler({
      auth: { token: { role: 'admin' } },
      data: buildValidPayload(),
    });

    expect(mockWithIdempotency).toHaveBeenCalledWith('edit-op-1', expect.any(Function));
    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['media-item:media-item-123'],
      expect.any(Function),
      expect.objectContaining({ operationKey: 'edit-op-1' })
    );
  });

  it('replays terminal results when the same operation key is retried', async () => {
    let cached: unknown;
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => {
      if (cached) {
        return cached as { id: string };
      }
      cached = await run();
      return cached as { id: string };
    });

    const request = {
      auth: { token: { role: 'admin' } },
      data: buildValidPayload(),
    };

    const first = await editHandler(request);
    const second = await editHandler(request);

    expect(first).toEqual(second);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('preserves standard busy lock details when contention occurs', async () => {
    const busyError = buildSubsplashLockBusyError({
      lockedKeys: ['media-item:media-item-123'],
      waitMs: 10_000,
      retryAfterMs: 250,
    });
    mockWithSubsplashLocks.mockRejectedValueOnce(busyError);

    await expect(
      editHandler({
        auth: { token: { role: 'admin' } },
        data: buildValidPayload(),
      })
    ).rejects.toMatchObject({
      code: 'aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['media-item:media-item-123'],
        wait_ms: 10_000,
        retry_after_ms: 250,
      },
    });
  });

  it('omits blank subtitle while preserving clearable summary fields when metadata is removed', async () => {
    await editHandler({
      auth: { token: { role: 'admin' } },
      data: {
        ...buildValidPayload(),
        subtitle: '',
        description: '',
        speakers: [],
        topics: [],
      },
    });

    const patchCall = mockAxios.mock.calls.find(
      ([config]) => (config as { method?: string; url?: string }).method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const requestConfig = patchCall?.[0] as unknown as { data: string };
    const requestData = JSON.parse(String(requestConfig.data));
    expect(requestData.tags).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(requestData, 'subtitle')).toBe(false);
    expect(requestData.summary).toBe('');
    expect(Object.prototype.hasOwnProperty.call(requestData._embedded ?? {}, 'audio')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(requestData._embedded ?? {}, 'media-series')).toBe(false);
  });

  it('uses the remote image id when present and falls back to the local id otherwise', async () => {
    await editHandler({
      auth: { token: { role: 'admin' } },
      data: {
        ...buildValidPayload(),
        images: [
          { id: 'image-1', type: 'square', subsplashId: 'subsplash-image-1' },
          { id: 'image-2', type: 'wide' },
        ],
      },
    });

    const patchCall = mockAxios.mock.calls.find(
      ([config]) => (config as { method?: string; url?: string }).method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const requestConfig = patchCall?.[0] as unknown as { data: string };
    const requestData = JSON.parse(String(requestConfig.data));
    expect(requestData._embedded.images).toEqual([
      {
        id: 'subsplash-image-1',
        type: 'square',
      },
      {
        id: 'image-2',
        type: 'wide',
      },
    ]);
  });

  it('repairs mismatched remote image ids before patching the sermon', async () => {
    mockAxios.mockImplementation((config: unknown) => {
      const request = config as { method?: string; url?: string; data?: unknown };
      const method = request.method?.toUpperCase();
      if (method === 'GET' && request.url === 'https://core.subsplash.com/files/v1/images/wide-remote') {
        return Promise.resolve({ data: { id: 'wide-remote', type: 'square' } } as never);
      }
      if (method === 'GET' && request.url === 'https://example.com/wide.jpg') {
        return Promise.resolve({
          data: Buffer.from('fake-image'),
          headers: { 'content-type': 'image/jpeg' },
        } as never);
      }
      if (method === 'POST' && request.url === 'https://core.subsplash.com/files/v1/images') {
        return Promise.resolve({
          data: {
            id: 'wide-repaired',
            _links: { presigned_upload_url: { href: 'https://upload.test/wide-repaired' } },
          },
        } as never);
      }
      if (method === 'PUT' && request.url === 'https://upload.test/wide-repaired') {
        return Promise.resolve({ data: null, status: 200 } as never);
      }
      if (method === 'PATCH' && request.url === 'https://core.subsplash.com/media/v1/media-items/media-item-123') {
        return Promise.resolve({ data: { ok: true } } as never);
      }
      return Promise.reject(new Error(`Unhandled axios request: ${method} ${request.url}`));
    });

    await editHandler({
      auth: { token: { role: 'admin' } },
      data: {
        ...buildValidPayload(),
        images: [
          { id: 'local-wide', type: 'wide', subsplashId: 'wide-remote', downloadLink: 'https://example.com/wide.jpg', name: 'Wide' },
        ],
      },
    });

    const patchCall = mockAxios.mock.calls.find(
      ([config]) => (config as { method?: string; url?: string }).method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const requestConfig = patchCall?.[0] as unknown as { data: string };
    const requestData = JSON.parse(String(requestConfig.data));
    expect(requestData._embedded.images).toEqual([{ id: 'wide-repaired', type: 'wide' }]);
  });
});
