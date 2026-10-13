export const mockUploadTrack = jest.fn();
export const mockDisposePreparedUpload = jest.fn();
export const mockPrepareMultipartUpload = jest.fn(async (params: unknown) => ({
  post: (token: string) => mockUploadTrack(token, params),
  dispose: mockDisposePreparedUpload,
}));
export const mockUpdateTrack = jest.fn();
export const mockDeleteTrack = jest.fn();
export const mockTokenValue = 'fake-soundcloud-token';
export const mockNormalizeSoundCloudApiError = jest.fn((error: unknown) => {
  throw error;
});
export const mockIsSoundCloudTrackNotFoundError = jest.fn((_error: unknown): boolean => false);

jest.mock('../../soundcloudClient', () => ({
  getAuthenticatedSoundCloudAccountId: async () => 'soundcloud:users:42',
  uploadTrack: (...args: unknown[]) => mockUploadTrack(...args),
  prepareMultipartUpload: (params: unknown) => mockPrepareMultipartUpload(params),
  updateTrack: (...args: unknown[]) => mockUpdateTrack(...args),
  deleteTrack: (...args: unknown[]) => mockDeleteTrack(...args),
  normalizeSoundCloudApiError: (error: unknown) => mockNormalizeSoundCloudApiError(error),
  isSoundCloudTrackNotFoundError: (error: unknown) => mockIsSoundCloudTrackNotFoundError(error),
}));

jest.mock('../../soundcloudSecrets', () => ({
  getSoundCloudAccessToken: () => mockTokenValue,
  refreshSoundCloudAccessToken: () => mockTokenValue,
  runWithSoundCloudAccessToken: (operation: (token: string) => unknown) => operation(mockTokenValue),
  soundcloudSecretsWithRuntimeAlerts: [],
  soundcloudOAuthSecrets: [],
}));

jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: 'urm-app' } }),
    firestore: () => jest.requireActual('firebase-admin/firestore').getFirestore(),
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
  onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: (req: unknown) => Promise<unknown>) =>
    typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler
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
