import axios from 'axios';
import type { Bucket } from '@google-cloud/storage';
import { deleteTrack, updateTrack, uploadTrack } from '../../soundcloudClient';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

const createBucket = (): Bucket =>
  ({
    file: () => ({
      download: jest.fn(async () => [Buffer.from('file-data')]),
    }),
  }) as unknown as Bucket;

describe('soundcloudClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the documented urn identifier in upload responses', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        urn: 'soundcloud:tracks:12345',
        id: 12345,
      },
    });

    const trackResult = await uploadTrack('access-token', {
      bucket: createBucket(),
      audioStoragePath: 'audio/file.mp3',
      title: 'Test track',
      tags: ['sermon'],
      description: 'Description',
    });

    expect(trackResult).toEqual({
      trackIdentifier: 'soundcloud:tracks:12345',
    });
  });

  it('URL-encodes track identifiers for metadata updates', async () => {
    mockedAxios.put.mockResolvedValue({
      data: {
        permalink_url: 'https://soundcloud.com/upper-room-media/test-track',
      },
    });

    const result = await updateTrack('access-token', 'soundcloud:tracks:12345', {
      title: 'Updated title',
    });

    expect(result).toEqual({
      trackIdentifier: 'soundcloud:tracks:12345',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/test-track',
    });

    expect(mockedAxios.put).toHaveBeenCalledWith(
      'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A12345',
      { track: { title: 'Updated title' } },
      expect.any(Object)
    );
  });

  it('URL-encodes track identifiers for deletes', async () => {
    mockedAxios.delete.mockResolvedValue({ data: {} });

    await deleteTrack('access-token', 'soundcloud:tracks:12345');

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A12345',
      expect.any(Object)
    );
  });
});
