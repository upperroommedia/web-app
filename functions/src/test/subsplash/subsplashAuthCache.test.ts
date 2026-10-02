import axios, { type AxiosRequestConfig } from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  authenticateSubsplash,
  clearSubsplashInMemoryAuthCacheForTests,
  resetSubsplashAuthCacheForTests,
} from '../../subsplashUtils';

jest.mock('axios');

const mockAxios = axios as jest.MockedFunction<typeof axios>;
const edgeRetryHandler = (axios.interceptors.response.use as jest.Mock).mock.calls
  .find(([onFulfilled, onRejected]) => onFulfilled === undefined && typeof onRejected === 'function')?.[1] as
  | ((error: unknown) => Promise<unknown>)
  | undefined;

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

  it('retries an HTML edge block during token refresh', async () => {
    mockAxios.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: '<html><title>403 Forbidden</title></html>',
        headers: { 'request-id': 'edge-request-1' },
      },
    }));
    mockAxios.mockResolvedValueOnce({ data: { access_token: 'fresh-token', expires_in: 300 } } as never);

    await expect(authenticateSubsplash()).resolves.toBe('fresh-token');
    expect(mockAxios).toHaveBeenCalledTimes(2);
    const firstRequest = mockAxios.mock.calls[0][0] as AxiosRequestConfig;
    const secondRequest = mockAxios.mock.calls[1][0] as AxiosRequestConfig;
    expect(firstRequest.data).not.toBe(secondRequest.data);
  });

  it('does not retry a JSON permission error', async () => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { error: 'forbidden' } },
    });
    mockAxios.mockRejectedValue(error);

    await expect(authenticateSubsplash()).rejects.toBe(error);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('retries a blocked Subsplash API request without retrying other hosts', async () => {
    expect(edgeRetryHandler).toBeDefined();
    (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    mockAxios.mockResolvedValue({ data: { id: 'media-item-1' } } as never);
    const blockedRequest = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      config: { url: 'https://core.subsplash.com/media/v1/media-items/media-item-1', method: 'get' },
      response: { status: 403, data: '<html><title>403 Forbidden</title></html>' },
    });

    await expect(edgeRetryHandler!(blockedRequest)).resolves.toMatchObject({ data: { id: 'media-item-1' } });
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({ skipSubsplashEdgeRetry: true }));

    const otherHostBlock = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      config: { url: 'https://example.com/resource', method: 'get' },
      response: { status: 403, data: '<html><title>403 Forbidden</title></html>' },
    });
    await expect(edgeRetryHandler!(otherHostBlock)).rejects.toBe(otherHostBlock);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });
});
