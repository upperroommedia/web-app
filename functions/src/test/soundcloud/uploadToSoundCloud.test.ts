import {
  mockUploadTrack,
} from './mocks';
import uploadToSoundCloud from '../../uploadToSoundCloud';
import type { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../../uploadToSoundCloud';

const handler = uploadToSoundCloud as unknown as (req: {
  auth?: { token?: { role?: string } };
  data: UploadToSoundCloudInputType;
}) => Promise<UploadToSoundCloudReturnType>;

describe('uploadToSoundCloud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadTrack.mockResolvedValue('sc-track-123');
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
    expect(result).toEqual({ soundCloudTrackId: 'sc-track-123' });
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
});
