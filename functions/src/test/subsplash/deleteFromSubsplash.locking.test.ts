import axios from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import deleteFromSubsplash from '../../deleteFromSubsplash';
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

type DeleteHandler = (request: {
  auth?: { token?: { role?: string } };
  data: Record<string, unknown>;
}) => Promise<unknown>;

const deleteHandler = deleteFromSubsplash as unknown as DeleteHandler;
const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;

const buildValidPayload = () => ({
  operationKey: 'delete-op-1',
  subsplashId: 'media-item-123',
});

describe('deleteFromSubsplash lock contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL = 'test@example.com';
    process.env.PASSWORD = 'test-password';
    mockAxios.mockResolvedValue({ status: 204, data: null } as never);
    mockAuthenticateSubsplash.mockResolvedValue('fake-token');
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());
  });

  it('throws HttpsError for unauthorized callers', async () => {
    await expect(deleteHandler({ data: buildValidPayload() })).rejects.toBeInstanceOf(HttpsError);
  });

  it('requires a non-empty operation key', async () => {
    await expect(
      deleteHandler({
        auth: { token: { role: 'admin' } },
        data: { ...buildValidPayload(), operationKey: '' },
      })
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it('wraps delete mutations with idempotency and media-item lock scope', async () => {
    await deleteHandler({
      auth: { token: { role: 'admin' } },
      data: buildValidPayload(),
    });

    expect(mockWithIdempotency).toHaveBeenCalledWith('delete-op-1', expect.any(Function));
    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['media-item:media-item-123'],
      expect.any(Function),
      expect.objectContaining({ operationKey: 'delete-op-1' })
    );
  });

  it('replays terminal results when the same operation key is retried', async () => {
    let cached = false;
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => {
      if (cached) {
        return undefined;
      }
      cached = true;
      return run();
    });

    const request = {
      auth: { token: { role: 'admin' } },
      data: buildValidPayload(),
    };
    await deleteHandler(request);
    await deleteHandler(request);

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
      deleteHandler({
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
