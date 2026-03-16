import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  authenticateSubsplash,
  clearSubsplashInMemoryAuthCacheForTests,
  resetSubsplashAuthCacheForTests,
} from '../../subsplashUtils';

jest.mock('axios');

const mockAxios = axios as jest.MockedFunction<typeof axios>;

describe('subsplash auth cache', () => {
  afterEach(async () => {
    await resetSubsplashAuthCacheForTests();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';
    await resetSubsplashAuthCacheForTests();
  });

  it('reuses the in-memory token while it is still fresh', async () => {
    mockAxios.mockResolvedValue({
      data: {
        access_token: 'token-1',
        expires_in: 300,
      },
    } as never);

    const first = await authenticateSubsplash();
    const second = await authenticateSubsplash();

    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('reuses the RTDB-cached token across in-memory cache clears', async () => {
    mockAxios.mockResolvedValue({
      data: {
        access_token: 'token-1',
        expires_in: 300,
      },
    } as never);

    const first = await authenticateSubsplash();
    clearSubsplashInMemoryAuthCacheForTests();
    const second = await authenticateSubsplash();

    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent auth refreshes into one OAuth request', async () => {
    let resolveAuth!: (value: unknown) => void;
    const pendingAuthResponse = new Promise((resolve) => {
      resolveAuth = resolve;
    });
    mockAxios.mockImplementation(
      () => pendingAuthResponse as never
    );

    const firstPromise = authenticateSubsplash();
    const secondPromise = authenticateSubsplash();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockAxios).toHaveBeenCalledTimes(1);

    resolveAuth({
      data: {
        access_token: 'token-1',
        expires_in: 300,
      },
    });

    await expect(firstPromise).resolves.toBe('token-1');
    await expect(secondPromise).resolves.toBe('token-1');
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token has expired', async () => {
    await firebaseAdmin.database().ref('subsplashAuthSession/cache').set({
      accessToken: 'expired-token',
      expiresAtMs: Date.now() - 5_000,
      refreshedAtMs: Date.now() - 10_000,
    });

    mockAxios.mockResolvedValue({
      data: {
        access_token: 'fresh-token',
        expires_in: 300,
      },
    } as never);

    const token = await authenticateSubsplash();
    const cachedSnapshot = await firebaseAdmin.database().ref('subsplashAuthSession/cache').get();

    expect(token).toBe('fresh-token');
    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect(cachedSnapshot.val()).toMatchObject({
      accessToken: 'fresh-token',
    });
  });
});
