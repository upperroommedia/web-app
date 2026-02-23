export const mockUploadTrack = jest.fn();
export const mockUpdateTrack = jest.fn();
export const mockDeleteTrack = jest.fn();
export const mockTokenValue = 'fake-soundcloud-token';

jest.mock('../../soundcloudClient', () => ({
  uploadTrack: (...args: unknown[]) => mockUploadTrack(...args),
  updateTrack: (...args: unknown[]) => mockUpdateTrack(...args),
  deleteTrack: (...args: unknown[]) => mockDeleteTrack(...args),
}));

jest.mock('../../soundcloudSecrets', () => ({
  soundcloudAccessToken: {
    value: () => mockTokenValue,
  },
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
  onCall: jest.fn((_opts: unknown, handler: (req: unknown) => Promise<unknown>) => handler),
  HttpsError: class HttpsError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  CallableRequest: undefined,
}));
