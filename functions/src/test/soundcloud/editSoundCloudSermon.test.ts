import { mockNormalizeSoundCloudApiError, mockUpdateTrack } from './mocks';
import editSoundCloudSermon from '../../editSoundCloudSermon';
import type { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA, EditSoundCloudSermonReturnType } from '../../editSoundCloudSermon';

const handler = editSoundCloudSermon as unknown as (req: {
  auth?: { token?: { role?: string } };
  data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA;
}) => Promise<EditSoundCloudSermonReturnType>;

describe('editSoundCloudSermon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateTrack.mockResolvedValue({
      trackIdentifier: 'sc-456',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/updated-sermon',
    });
    mockNormalizeSoundCloudApiError.mockImplementation((error: unknown) => {
      throw error;
    });
  });

  it('calls updateTrack when authenticated and data is valid', async () => {
    const result = await handler({
      auth: { token: { role: 'admin' } },
      data: {
        trackId: 'sc-456',
        title: 'Updated Title',
        description: 'Updated desc',
        tags: ['a', 'b'],
      },
    });
    expect(result).toEqual({
      soundCloudTrackUrl: 'https://soundcloud.com/upper-room-media/updated-sermon',
    });
    expect(mockUpdateTrack).toHaveBeenCalledTimes(1);
    expect(mockUpdateTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      'sc-456',
      expect.objectContaining({
        title: 'Updated Title',
        description: 'Updated desc',
        tags: ['a', 'b'],
      })
    );
  });

  it('passes imageSource through when provided', async () => {
    await handler({
      auth: { token: { role: 'admin' } },
      data: {
        trackId: 'sc-456',
        imageSource: 'https://storage.googleapis.com/urm-app-prod.firebasestorage.app/speaker-images/image-square.jpeg',
      },
    });

    expect(mockUpdateTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      'sc-456',
      expect.objectContaining({
        imageSource: 'https://storage.googleapis.com/urm-app-prod.firebasestorage.app/speaker-images/image-square.jpeg',
      })
    );
  });

  it('throws permission-denied when role cannot publish', async () => {
    await expect(
      handler({
        auth: { token: { role: 'user' } },
        data: { trackId: 'sc-456', title: 'X' },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockUpdateTrack).not.toHaveBeenCalled();
  });

  it('throws when unauthenticated', async () => {
    await expect(
      handler({
        auth: undefined,
        data: { trackId: 'sc-456' },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockUpdateTrack).not.toHaveBeenCalled();
  });

  it('normalizes invalid SoundCloud credentials', async () => {
    mockUpdateTrack.mockRejectedValue(new Error('Request failed with status code 401'));
    mockNormalizeSoundCloudApiError.mockImplementation(() => {
      throw Object.assign(new Error('Invalid SoundCloud token'), { code: 'failed-precondition' });
    });

    await handler({
      auth: { token: { role: 'admin' } },
      data: { trackId: 'sc-456', title: 'X' },
    })
      .then(() => {
        throw new Error('Expected handler to reject');
      })
      .catch((error: { code?: string; message?: string }) => {
        expect(error.code).toBe('internal');
        expect(error.message).toBe('Invalid SoundCloud token');
      });
  });
});
