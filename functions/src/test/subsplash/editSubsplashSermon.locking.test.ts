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
    process.env.EMAIL = 'test@example.com';
    process.env.PASSWORD = 'test-password';
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
});
