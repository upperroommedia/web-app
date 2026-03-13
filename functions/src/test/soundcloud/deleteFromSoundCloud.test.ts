import { mockDeleteTrack, mockNormalizeSoundCloudApiError } from './mocks';
import deleteFromSoundCloud from '../../deleteFromSoundCloud';
import type { DeleteFromSoundCloudInputType } from '../../deleteFromSoundCloud';

const handler = deleteFromSoundCloud as unknown as (req: {
  auth?: { token?: { role?: string } };
  data: DeleteFromSoundCloudInputType;
}) => Promise<void>;

describe('deleteFromSoundCloud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteTrack.mockResolvedValue(undefined);
    mockNormalizeSoundCloudApiError.mockImplementation((error: unknown) => {
      throw error;
    });
  });

  it('calls deleteTrack with soundCloudTrackId when authenticated', async () => {
    await handler({
      auth: { token: { role: 'admin' } },
      data: { soundCloudTrackId: 'sc-789' },
    });
    expect(mockDeleteTrack).toHaveBeenCalledTimes(1);
    expect(mockDeleteTrack).toHaveBeenCalledWith('fake-soundcloud-token', 'sc-789');
  });

  it('throws when unauthenticated', async () => {
    await expect(
      handler({
        auth: undefined,
        data: { soundCloudTrackId: 'sc-789' },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(mockDeleteTrack).not.toHaveBeenCalled();
  });

  it('throws when role cannot publish', async () => {
    await expect(
      handler({
        auth: { token: { role: 'user' } },
        data: { soundCloudTrackId: 'sc-789' },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(mockDeleteTrack).not.toHaveBeenCalled();
  });

  it('normalizes invalid SoundCloud credentials', async () => {
    mockDeleteTrack.mockRejectedValue(new Error('Request failed with status code 401'));
    mockNormalizeSoundCloudApiError.mockImplementation(() => {
      throw Object.assign(new Error('Invalid SoundCloud token'), { code: 'failed-precondition' });
    });

    await handler({
      auth: { token: { role: 'admin' } },
      data: { soundCloudTrackId: 'sc-789' },
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
