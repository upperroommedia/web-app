import axios from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';
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

  it('preserves standard busy lock details when contention occurs', async () => {
    const busyError = buildSubsplashLockBusyError({
      lockedKeys: ['media-item:media-item-123'],
      waitMs: 10_000,
      retryAfterMs: 250,
    });
    mockAuthenticateSubsplash.mockRejectedValueOnce(busyError);

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
