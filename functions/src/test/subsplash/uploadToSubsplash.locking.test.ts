import axios from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import uploadToSubsplash from '../../uploadToSubsplash';
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

type UploadHandler = (request: {
  auth?: { token?: { role?: string } };
  data: Record<string, unknown>;
}) => Promise<unknown>;

const uploadHandler = uploadToSubsplash as unknown as UploadHandler;
const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;

const buildValidPayload = () => ({
  operationKey: 'upload-op-1',
  lockKey: 'sermon-1',
  title: 'Sermon title',
  subtitle: 'Sermon subtitle',
  speakers: [],
  autoPublish: false,
  audioTitle: 'Audio title',
  audioUrl: 'https://example.com/audio.mp3',
  topics: [],
  description: 'desc',
  images: [],
  date: new Date(),
});

describe('uploadToSubsplash lock contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';
    mockAxios.mockResolvedValue({ data: { id: 'media-item-1' } } as never);
    mockAuthenticateSubsplash.mockResolvedValue('fake-token');
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());
  });

  it('throws HttpsError for unauthorized callers', async () => {
    await expect(uploadHandler({ data: buildValidPayload() })).rejects.toBeInstanceOf(HttpsError);
  });

  it('requires a non-empty operation key', async () => {
    await expect(
      uploadHandler({
        auth: { token: { role: 'admin' } },
        data: { ...buildValidPayload(), operationKey: '   ' },
      })
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it('wraps mutations with idempotency and media-item lock scope', async () => {
    await uploadHandler({
      auth: { token: { role: 'admin' } },
      data: buildValidPayload(),
    });

    expect(mockWithIdempotency).toHaveBeenCalledWith('upload-op-1', expect.any(Function));
    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['media-item:sermon-1'],
      expect.any(Function),
      expect.objectContaining({ operationKey: 'upload-op-1' })
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
    const first = await uploadHandler(request);
    const second = await uploadHandler(request);

    expect(first).toEqual(second);
    expect(mockAxios).toHaveBeenCalledTimes(3);
  });

  it('preserves standard busy lock details when contention occurs', async () => {
    const busyError = buildSubsplashLockBusyError({
      lockedKeys: ['media-item:sermon-1'],
      waitMs: 10_000,
      retryAfterMs: 250,
    });
    mockWithSubsplashLocks.mockRejectedValueOnce(busyError);

    await expect(
      uploadHandler({
        auth: { token: { role: 'admin' } },
        data: buildValidPayload(),
      })
    ).rejects.toMatchObject({
      code: 'aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['media-item:sermon-1'],
        wait_ms: 10_000,
        retry_after_ms: 250,
      },
    });
  });

  it('repairs mismatched remote image ids before creating the media item', async () => {
    mockAxios.mockImplementation((config: unknown) => {
      const request = config as { method?: string; url?: string; data?: unknown; responseType?: string };
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
      if (method === 'POST' && request.url === ' https://core.subsplash.com/files/v1/audios') {
        return Promise.resolve({ data: { id: 'audio-1' } } as never);
      }
      if (method === 'POST' && request.url === 'https://core.subsplash.com/transcoder/v1/jobs') {
        return Promise.resolve({ data: { status: 'queued' } } as never);
      }
      if (method === 'POST' && request.url === 'https://core.subsplash.com/media/v1/media-items') {
        return Promise.resolve({ data: { id: 'media-item-1' } } as never);
      }
      return Promise.reject(new Error(`Unhandled axios request: ${method} ${request.url}`));
    });

    await uploadHandler({
      auth: { token: { role: 'admin' } },
      data: {
        ...buildValidPayload(),
        images: [
          {
            id: 'local-wide',
            subsplashId: 'wide-remote',
            type: 'wide',
            downloadLink: 'https://example.com/wide.jpg',
            name: 'Wide',
          },
        ],
      },
    });

    const mediaItemCall = mockAxios.mock.calls.find(
      ([config]) => (config as { url?: string }).url === 'https://core.subsplash.com/media/v1/media-items'
    );
    expect(mediaItemCall).toBeDefined();
    const requestConfig = mediaItemCall?.[0] as unknown as { data: string };
    const requestData = JSON.parse(String(requestConfig.data));
    expect(requestData._embedded.images).toEqual([{ id: 'wide-repaired', type: 'wide' }]);
  });

  it('omits blank subtitle values from the create payload', async () => {
    await uploadHandler({
      auth: { token: { role: 'admin' } },
      data: {
        ...buildValidPayload(),
        subtitle: '   ',
      },
    });

    const mediaItemCall = mockAxios.mock.calls.find(
      ([config]) => (config as { url?: string }).url === 'https://core.subsplash.com/media/v1/media-items'
    );
    expect(mediaItemCall).toBeDefined();
    const requestConfig = mediaItemCall?.[0] as unknown as { data: string };
    const requestData = JSON.parse(String(requestConfig.data));
    expect(Object.prototype.hasOwnProperty.call(requestData, 'subtitle')).toBe(false);
  });
});
