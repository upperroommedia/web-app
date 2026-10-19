import axios from 'axios';
import type { Bucket } from '@google-cloud/storage';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { uploadTrack } from '../../soundcloudClient';

type Reply = { status: number; body: unknown } | 'disconnect';
const edgeRejection: Reply = { status: 400, body: '<html><body>Temporary edge rejection</body></html>' };
const accepted: Reply = { status: 201, body: { urn: 'soundcloud:tracks:12345' } };

describe('SoundCloud upload recovery', () => {
  let server: Server;
  let interceptor: number;
  let replies: Reply[];
  let bodies: string[];
  let streams: Readable[];
  let bucket: Bucket;

  beforeEach(async () => {
    replies = [];
    bodies = [];
    streams = [];
    bucket = {
      file: (path: string) => ({
        getMetadata: async () => [{ size: '11', contentType: path.endsWith('.jpg') ? 'image/jpeg' : 'audio/mpeg' }],
        createReadStream: () => {
          const stream = Readable.from([Buffer.from('test-media!')]);
          streams.push(stream);
          return stream;
        },
      }),
    } as unknown as Bucket;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
      const reply = replies.shift();
      if (reply === 'disconnect') {
        request.socket.destroy();
        return;
      }
      response.writeHead(reply?.status ?? 500, {
        'content-type': typeof reply?.body === 'string' ? 'text/html' : 'application/json',
      });
      response.end(typeof reply?.body === 'string' ? reply.body : JSON.stringify(reply?.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    interceptor = axios.interceptors.request.use((config) => {
      if (config.url === 'https://api.soundcloud.com/tracks' || config.url === 'https://example.test/artwork.jpg') {
        config.url = `http://127.0.0.1:${address.port}/tracks`;
      }
      return config;
    });
  });

  afterEach(async () => {
    axios.interceptors.request.eject(interceptor);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const params = () => ({
    bucket,
    audioStoragePath: 'audio/test.mp3',
    imageSource: 'artwork/test.jpg',
    title: 'Test upload',
    description: 'Synthetic description',
    tags: ['test'],
  });

  it('rebuilds and sends complete audio and artwork after an explicit HTML 400 rejection', async () => {
    replies.push(edgeRejection, accepted);
    await expect(uploadTrack('synthetic-token', params())).resolves.toEqual({
      trackIdentifier: 'soundcloud:tracks:12345',
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('name="track[title]"');
      expect(body).toContain('filename="test.mp3"');
      expect(body).toContain('filename="test.jpg"');
      expect(body.match(/test-media!/g)).toHaveLength(2);
    }
    expect(bodies[0].split('\r\n')[0]).not.toBe(bodies[1].split('\r\n')[0]);
    expect(streams).toHaveLength(4);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('bounds repeated edge rejections and returns a sanitized availability error', async () => {
    replies.push(edgeRejection, edgeRejection, accepted);
    await expect(uploadTrack('synthetic-token', params())).rejects.toMatchObject({
      code: 'unavailable',
      details: { code: 'SOUNDCLOUD_UPLOAD_EDGE_REJECTED', upstream_status: 400 },
    });
    expect(bodies).toHaveLength(2);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it.each([
    { status: 400, body: { errors: [{ field: 'title', message: 'Synthetic validation failure' }] } },
    { status: 400, body: 'Bad request' },
    { status: 401, body: { error: 'Unauthorized' } },
    { status: 422, body: { error: 'Invalid media' } },
    { status: 500, body: '<html>Unknown outcome</html>' },
  ])('does not replay other upstream responses ($status)', async (reply) => {
    replies.push(reply, accepted);
    await expect(uploadTrack('synthetic-token', params())).rejects.toMatchObject({
      response: { status: reply.status },
    });
    expect(bodies).toHaveLength(1);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('does not replay an ambiguous connection failure after the upload was sent', async () => {
    replies.push('disconnect', accepted);
    await expect(uploadTrack('synthetic-token', params())).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  it('does not mistake an artwork download rejection for a rejected track upload', async () => {
    replies.push(edgeRejection, accepted);
    await expect(
      uploadTrack('synthetic-token', { ...params(), imageSource: 'https://example.test/artwork.jpg' })
    ).rejects.toMatchObject({ response: { status: 400 }, config: { method: 'get' } });
    expect(bodies).toEqual(['']);
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
  });
});
