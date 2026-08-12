import axios from 'axios';
import type { Bucket } from '@google-cloud/storage';
import {
  deleteTrack,
  isSoundCloudTrackNotFoundError,
  updateTrack,
  uploadTrack,
} from '../../soundcloudClient';
import { Readable } from 'node:stream';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

type MockFile = {
  getMetadata: jest.Mock;
  createReadStream: jest.Mock;
};

const createBucket = (): Bucket & { __file: MockFile } => {
  const file = {
    getMetadata: jest.fn(async () => [{ size: '9', contentType: 'audio/mpeg' }]),
    createReadStream: jest.fn(() => Readable.from(['file-data'])),
  };

  return {
    file: jest.fn(() => file),
    __file: file,
  } as unknown as Bucket & { __file: MockFile };
};

describe('soundcloudClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the documented urn identifier in upload responses', async () => {
    const bucket = createBucket();
    mockedAxios.post.mockResolvedValue({
      data: {
        urn: 'soundcloud:tracks:12345',
        id: 12345,
      },
    });

    const trackResult = await uploadTrack('access-token', {
      bucket,
      audioStoragePath: 'audio/file.mp3',
      title: 'Test track',
      tags: ['sermon'],
      description: 'Description',
    });

    expect(trackResult).toEqual({
      trackIdentifier: 'soundcloud:tracks:12345',
    });
    expect(bucket.__file.getMetadata).toHaveBeenCalled();
    expect(bucket.__file.createReadStream).toHaveBeenCalled();
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

  it('recognizes a missing remote track from a SoundCloud 404 response', () => {
    const notFoundError = { response: { status: 404 } };
    mockedAxios.isAxiosError.mockImplementation((error: unknown) => error === notFoundError);

    expect(isSoundCloudTrackNotFoundError(notFoundError)).toBe(true);
    expect(isSoundCloudTrackNotFoundError({ response: { status: 404 } })).toBe(false);
  });

  it('streams remote artwork instead of buffering it before upload', async () => {
    const bucket = createBucket();
    mockedAxios.get.mockResolvedValue({
      data: Readable.from(['image-data']),
      headers: {
        'content-type': 'image/png',
        'content-length': '10',
      },
    } as never);
    mockedAxios.post.mockResolvedValue({
      data: {
        urn: 'soundcloud:tracks:999',
      },
    });

    await uploadTrack('access-token', {
      bucket,
      audioStoragePath: 'audio/file.mp3',
      imageSource: 'https://storage.googleapis.com/example/image.png',
      title: 'Test track',
      tags: ['sermon'],
      description: 'Description',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith('https://storage.googleapis.com/example/image.png', {
      responseType: 'stream',
    });
  });

  it('streams artwork updates from storage instead of downloading buffers', async () => {
    const bucket = createBucket();
    bucket.__file.getMetadata.mockResolvedValueOnce([{ size: '10', contentType: 'image/jpeg' }]);
    mockedAxios.put.mockResolvedValue({
      data: {
        permalink_url: 'https://soundcloud.com/upper-room-media/test-track',
      },
    });

    await updateTrack('access-token', 'soundcloud:tracks:12345', {
      imageSource: 'images/artwork.jpg',
      bucket,
    });

    expect(bucket.__file.getMetadata).toHaveBeenCalled();
    expect(bucket.__file.createReadStream).toHaveBeenCalled();
  });
});
