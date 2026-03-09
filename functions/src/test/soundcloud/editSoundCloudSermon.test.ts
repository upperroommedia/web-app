import { mockUpdateTrack } from './mocks';
import editSoundCloudSermon from '../../editSoundCloudSermon';
import type { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA } from '../../editSoundCloudSermon';

const handler = editSoundCloudSermon as unknown as (req: {
  auth?: { token?: { role?: string } };
  data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA;
}) => Promise<void>;

describe('editSoundCloudSermon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateTrack.mockResolvedValue(undefined);
  });

  it('calls updateTrack when authenticated and data is valid', async () => {
    await handler({
      auth: { token: { role: 'admin' } },
      data: {
        trackId: 'sc-456',
        title: 'Updated Title',
        description: 'Updated desc',
        tags: ['a', 'b'],
      },
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
});
