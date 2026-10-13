import axios from 'axios';
import type { Bucket } from '@google-cloud/storage';
import {
  deleteTrack,
  inferMultipartFilename,
  isSoundCloudTrackNotFoundError,
  normalizeSoundCloudApiError,
  updateTrack,
  uploadTrack,
  prepareMultipartUpload,
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
    let postedParts: unknown[] = [];
    mockedAxios.post.mockImplementation(async (_url, form) => {
      postedParts = [...(form as { _streams: unknown[] })._streams];
      return { data: { urn: 'soundcloud:tracks:12345', id: 12345 } };
    });

    const trackResult = await uploadTrack('access-token', {
      bucket,
      audioStoragePath: 'intro-outro-sermons/e9a3bcad-4764-4938-a33b-957459d20b8e',
      title: 'Test track',
      tags: ['sermon'],
      description: 'Description',
    });

    expect(trackResult).toEqual({
      trackIdentifier: 'soundcloud:tracks:12345',
    });
    expect(bucket.__file.getMetadata).toHaveBeenCalled();
    expect(bucket.__file.createReadStream).toHaveBeenCalled();
    expect(
      postedParts.some(
        (entry) => typeof entry === 'string' && entry.includes('filename="e9a3bcad-4764-4938-a33b-957459d20b8e.mp3"')
      )
    ).toBe(true);
  });

  it('adds the known audio extension to extensionless production storage paths', () => {
    expect(inferMultipartFilename('intro-outro-sermons/e9a3bcad-4764-4938-a33b-957459d20b8e', 'audio.mp3')).toBe(
      'e9a3bcad-4764-4938-a33b-957459d20b8e.mp3'
    );
  });

  it('adds the known artwork extension to extensionless storage paths', () => {
    expect(inferMultipartFilename('/v0/b/urm-app.appspot.com/o/sermon-images/square-artwork-id', 'artwork.jpg')).toBe(
      'square-artwork-id.jpg'
    );
  });

  it('preserves a source filename that already declares its format', () => {
    expect(inferMultipartFilename('audio/sermon.wav', 'audio.mp3')).toBe('sermon.wav');
  });

  it('URL-encodes track identifiers for metadata updates', async () => {
    mockedAxios.put.mockResolvedValue({
      status: 200,
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
    mockedAxios.delete.mockResolvedValue({ status: 204, data: {} });

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

  it('reports an HTML edge block as temporary rather than a permission failure', () => {
    expect(() =>
      normalizeSoundCloudApiError({
        response: { status: 403, data: '<html><title>403 Forbidden</title></html>' },
      })
    ).toThrow('SoundCloud temporarily blocked the track request from our server. Please retry shortly.');
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
    let postedParts: unknown[] = [];
    mockedAxios.post.mockImplementation(async (_url, form) => {
      postedParts = [...(form as { _streams: unknown[] })._streams];
      return { data: { urn: 'soundcloud:tracks:999' } };
    });

    const extensionlessArtworkUrl =
      'https://firebasestorage.googleapis.com/v0/b/example/o/sermon-images%2Fsquare-artwork-id?alt=media';
    await uploadTrack('access-token', {
      bucket,
      audioStoragePath: 'audio/file.mp3',
      imageSource: extensionlessArtworkUrl,
      title: 'Test track',
      tags: ['sermon'],
      description: 'Description',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      extensionlessArtworkUrl,
      expect.objectContaining({ responseType: 'stream' })
    );
    expect(
      postedParts.some((entry) => typeof entry === 'string' && entry.includes('filename="square-artwork-id.jpg"'))
    ).toBe(true);
  });

  it('streams artwork updates from storage instead of downloading buffers', async () => {
    const bucket = createBucket();
    bucket.__file.getMetadata.mockResolvedValueOnce([{ size: '10', contentType: 'image/jpeg' }]);
    mockedAxios.put.mockResolvedValue({
      status: 200,
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
  it('does not start a provider POST when safe source metadata preparation fails', async () => {
    const bucket = createBucket();
    bucket.__file.getMetadata.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(
      prepareMultipartUpload({ bucket, audioStoragePath: 'audio.mp3', title: 'Track', tags: [], description: '' })
    ).rejects.toThrow('Storage unavailable');
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(bucket.__file.createReadStream).not.toHaveBeenCalled();
  });
  it('destroys an allocated audio stream when artwork preparation fails', async () => {
    const bucket = createBucket();
    const stream = Readable.from(['audio']);
    bucket.__file.createReadStream.mockReturnValue(stream);
    mockedAxios.get.mockRejectedValueOnce(new Error('Artwork unavailable'));
    await expect(
      prepareMultipartUpload({
        bucket,
        audioStoragePath: 'audio.mp3',
        imageSource: 'https://storage.example/image',
        title: 'Track',
        tags: [],
        description: '',
      })
    ).rejects.toThrow('Artwork unavailable');
    expect(stream.destroyed).toBe(true);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
  it('closes prepared streams without posting when a durable receipt is replayed or lost', async () => {
    const bucket = createBucket();
    const stream = Readable.from(['audio']);
    bucket.__file.createReadStream.mockReturnValue(stream);
    const prepared = await prepareMultipartUpload({
      bucket,
      audioStoragePath: 'audio.mp3',
      title: 'Track',
      tags: [],
      description: '',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    prepared.dispose();
    prepared.dispose();
    expect(stream.destroyed).toBe(true);
    await expect(prepared.post('token')).rejects.toThrow('only be posted once');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
  it('closes source streams after a provider response is lost', async () => {
    const bucket = createBucket();
    const stream = Readable.from(['audio']);
    bucket.__file.createReadStream.mockReturnValue(stream);
    mockedAxios.post.mockRejectedValueOnce(new Error('Response lost'));
    await expect(
      uploadTrack('token', { bucket, audioStoragePath: 'audio.mp3', title: 'Track', tags: [], description: '' })
    ).rejects.toThrow('Response lost');
    expect(stream.destroyed).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
