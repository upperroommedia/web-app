export const mockUploadTrack = jest.fn();
export const mockUpdateTrack = jest.fn();
export const mockDeleteTrack = jest.fn();
export const mockTokenValue = 'fake-soundcloud-token';
export const mockNormalizeSoundCloudApiError = jest.fn((error: unknown) => {
  throw error;
});

jest.mock('../../soundcloudClient', () => ({
  uploadTrack: (...args: unknown[]) => mockUploadTrack(...args),
  updateTrack: (...args: unknown[]) => mockUpdateTrack(...args),
  deleteTrack: (...args: unknown[]) => mockDeleteTrack(...args),
  normalizeSoundCloudApiError: (error: unknown) => mockNormalizeSoundCloudApiError(error),
}));

jest.mock('../../soundcloudSecrets', () => ({
  getSoundCloudAccessToken: () => mockTokenValue,
  refreshSoundCloudAccessToken: () => mockTokenValue,
  runWithSoundCloudAccessToken: (operation: (token: string) => unknown) => operation(mockTokenValue),
  soundcloudSecretsWithRuntimeAlerts: [],
  soundcloudOAuthSecrets: [],
}));

jest.mock('../../../../firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    storage: () => ({
      bucket: () => ({
        file: () => ({
          download: () => Promise.resolve([Buffer.alloc(0)]),
        }),
      }),
    }),
  },
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
    readonly details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  CallableRequest: undefined,
}));
