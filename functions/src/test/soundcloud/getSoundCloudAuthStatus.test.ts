const mockGetSoundCloudAuthStatus = jest.fn();

jest.mock('../../soundcloudSecrets', () => ({
  getSoundCloudAuthStatus: (...args: unknown[]) => mockGetSoundCloudAuthStatus(...args),
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

import getSoundCloudAuthStatus from '../../getSoundCloudAuthStatus';
import type { GetSoundCloudAuthStatusReturnType } from '../../getSoundCloudAuthStatus';

const handler = getSoundCloudAuthStatus as unknown as (req: {
  auth?: { token?: { role?: string } };
}) => Promise<GetSoundCloudAuthStatusReturnType>;

describe('getSoundCloudAuthStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSoundCloudAuthStatus.mockResolvedValue({
      clientId: 'client-id',
      callbackPath: '/auth/soundcloud/callback',
      configured: true,
      connected: true,
      tokenSource: 'firestore',
      connectedByEmail: 'admin@example.com',
      connectedAtMillis: 123,
      updatedAtMillis: 456,
      accessTokenExpiresAtMillis: 789,
    });
  });

  it('returns auth status for admins', async () => {
    await expect(handler({ auth: { token: { role: 'admin' } } })).resolves.toMatchObject({
      connected: true,
      tokenSource: 'firestore',
    });
    expect(mockGetSoundCloudAuthStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects non-admin callers', async () => {
    await expect(handler({ auth: { token: { role: 'publisher' } } })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});
