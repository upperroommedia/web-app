import {
  mockUploadTrack,
  mockNormalizeSoundCloudApiError,
} from './mocks';
import uploadToSoundCloud from '../../uploadToSoundCloud';
import type { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../../uploadToSoundCloud';
import { HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert } from '../../notifications/emitOperationalAlert';

jest.mock('../../notifications/emitOperationalAlert', () => ({
  emitOperationalAlert: jest.fn(async () => undefined),
}));

const handler = uploadToSoundCloud as unknown as (req: {
  auth?: { token?: { role?: string } };
  data: UploadToSoundCloudInputType;
}) => Promise<UploadToSoundCloudReturnType>;

describe('uploadToSoundCloud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadTrack.mockResolvedValue({
      trackIdentifier: 'sc-track-123',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/test-sermon',
    });
    mockNormalizeSoundCloudApiError.mockImplementation((error: unknown) => {
      throw error;
    });
  });

  it('returns soundCloudTrackId when authenticated and upload succeeds', async () => {
    const result = await handler({
      auth: { token: { role: 'admin' } },
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test Sermon',
        speakers: ['Speaker A'],
        tags: ['tag1', 'tag2'],
        description: 'A test.',
      },
    });
    expect(result).toEqual({
      soundCloudTrackId: 'sc-track-123',
      soundCloudTrackUrl: 'https://soundcloud.com/upper-room-media/test-sermon',
    });
    expect(mockUploadTrack).toHaveBeenCalledTimes(1);
    expect(mockUploadTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      expect.objectContaining({
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test Sermon',
        tags: ['tag1', 'tag2'],
        description: 'A test.',
      })
    );
  });

  it('includes imageSource when provided', async () => {
    await handler({
      auth: { token: { role: 'admin' } },
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test',
        speakers: [],
        tags: [],
        description: '',
        imageSource: 'https://firebasestorage.googleapis.com/v0/b/urm-app-prod.firebasestorage.app/o/speaker-images%2Fsome.jpg?alt=media&token=abc',
      },
    });
    expect(mockUploadTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      expect.objectContaining({
        imageSource: 'https://firebasestorage.googleapis.com/v0/b/urm-app-prod.firebasestorage.app/o/speaker-images%2Fsome.jpg?alt=media&token=abc',
      })
    );
  });

  it('throws when unauthenticated', async () => {
    await expect(
      handler({
        auth: undefined,
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-1',
          title: 'Test',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('authenticated') });
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });

  it('throws when role cannot publish', async () => {
    await expect(
      handler({
        auth: { token: { role: 'user' } },
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-1',
          title: 'Test',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });

  it('surfaces invalid SoundCloud credentials as failed-precondition', async () => {
    mockUploadTrack.mockRejectedValue(new Error('Request failed with status code 401'));
    mockNormalizeSoundCloudApiError.mockImplementation(() => {
      throw new HttpsError('failed-precondition', 'Invalid SoundCloud token');
    });

    await expect(
      handler({
        auth: { token: { role: 'admin' } },
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-1',
          title: 'Test',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Invalid SoundCloud token',
    });
  });

  it('surfaces SoundCloud upload validation failures without emitting a runtime alert', async () => {
    const validationError = new HttpsError(
      'invalid-argument',
      'SoundCloud rejected the track upload. Check the title, description, tags, artwork, and audio file, then try again.',
      {
        code: 'SOUNDCLOUD_UPLOAD_REJECTED',
        upstream_status: 400,
      }
    );
    mockUploadTrack.mockRejectedValue(new Error('Request failed with status code 400'));
    mockNormalizeSoundCloudApiError.mockImplementation(() => {
      throw validationError;
    });

    await expect(
      handler({
        auth: { token: { role: 'admin' } },
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-validation',
          title: 'Rejected upload',
          speakers: ['Speaker A'],
          tags: ['tag-a'],
          description: 'Description.',
          imageSource: 'https://storage.example.test/artwork.jpg',
        },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('SoundCloud rejected the track upload'),
      details: {
        code: 'SOUNDCLOUD_UPLOAD_REJECTED',
        upstream_status: 400,
      },
    });
    expect(emitOperationalAlert).not.toHaveBeenCalled();
  });
});
