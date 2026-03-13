const mockExchangeSoundCloudAuthorizationCode = jest.fn();

jest.mock('../../soundcloudSecrets', () => ({
  exchangeSoundCloudAuthorizationCode: (...args: unknown[]) => mockExchangeSoundCloudAuthorizationCode(...args),
  soundcloudOAuthSecrets: [],
}));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn(
    (
      optsOrHandler: unknown,
      maybeHandler?: (req: unknown) => Promise<unknown>
    ) => (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
  ),
  HttpsError: class HttpsError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  CallableRequest: undefined,
}));

import exchangeSoundCloudAuthCode from '../../exchangeSoundCloudAuthCode';
import type {
  ExchangeSoundCloudAuthCodeInput,
  ExchangeSoundCloudAuthCodeReturnType,
} from '../../exchangeSoundCloudAuthCode';

const handler = exchangeSoundCloudAuthCode as unknown as (req: {
  auth?: { uid?: string; token?: { role?: string; email?: string } };
  data: ExchangeSoundCloudAuthCodeInput;
}) => Promise<ExchangeSoundCloudAuthCodeReturnType>;

describe('exchangeSoundCloudAuthCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeSoundCloudAuthorizationCode.mockResolvedValue({
      connected: true,
      connectedAtMillis: 123,
      accessTokenExpiresAtMillis: 456,
      connectedByEmail: 'admin@example.com',
    });
  });

  it('passes the auth metadata through for admins', async () => {
    const data: ExchangeSoundCloudAuthCodeInput = {
      code: 'soundcloud-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://staging.uploader.upperroommedia.org/auth/soundcloud/callback',
    };

    await expect(
      handler({
        auth: { uid: 'user-1', token: { role: 'admin', email: 'admin@example.com' } },
        data,
      })
    ).resolves.toMatchObject({
      connected: true,
      connectedByEmail: 'admin@example.com',
    });

    expect(mockExchangeSoundCloudAuthorizationCode).toHaveBeenCalledWith({
      ...data,
      connectedByUid: 'user-1',
      connectedByEmail: 'admin@example.com',
    });
  });

  it('rejects non-admin callers', async () => {
    await expect(
      handler({
        auth: { uid: 'user-2', token: { role: 'publisher', email: 'publisher@example.com' } },
        data: {
          code: 'soundcloud-code',
          codeVerifier: 'pkce-verifier',
          redirectUri: 'https://staging.uploader.upperroommedia.org/auth/soundcloud/callback',
        },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
