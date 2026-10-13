import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createSingleShotClaimsTransport,
  createSingleShotSessionTransport,
  validateFrozenAccountClaims,
} from './authClaimsTransport';

/** Real TCP/HTTP failure boundary; no Firebase/Google service contacted. */
describe('single-shot account claims transport', () => {
  let server: Server;
  let endpoint: string;
  let requests: Array<{ url: string; authorization?: string; body: unknown }>;
  beforeEach(async () => {
    requests = [];
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const capture = (drop: boolean) =>
    server.on('request', (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          url: request.url!,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        if (drop) request.socket.destroy();
        else {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{}');
        }
      });
    });
  it('sends exactly one POST when the server accepts the body then drops its acknowledgement', async () => {
    capture(true);
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(
      send('urm-app-staging', 'user1', { role: 'publisher', temporalAccountClaimJobId: 'job1' })
    ).rejects.toThrow('ACCOUNT_CLAIMS_TRANSPORT_RESULT_UNKNOWN');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: '/v1/projects/urm-app-staging/accounts:update',
      authorization: 'Bearer local-test-token',
      body: {
        localId: 'user1',
        customAttributes: JSON.stringify({ role: 'publisher', temporalAccountClaimJobId: 'job1' }),
      },
    });
  });
  it('acknowledges one successful POST and preserves all supplied claims', async () => {
    capture(false);
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(send('urm-app-staging', 'user1', { role: 'user', other: true })).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });
  it('sends one frozen validSince POST after an accepted request loses its acknowledgement', async () => {
    capture(true);
    const send = createSingleShotSessionTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(
      send('urm-app-staging', 'user1', '1791766123', {
        role: 'user',
        temporalAccountSessionOperationId: 'unique-session',
      })
    ).rejects.toThrow('RESULT_UNKNOWN');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      localId: 'user1',
      validSince: '1791766123',
      customAttributes: JSON.stringify({ role: 'user', temporalAccountSessionOperationId: 'unique-session' }),
    });
  });

  it('rejects oversized or reserved frozen claims before any HTTP request', async () => {
    capture(false);
    expect(() => validateFrozenAccountClaims({ role: 'user', aud: 'reserved' })).toThrow('RESERVED_KEY');
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    expect(() =>
      send('urm-app-staging', 'user1', { temporalAccountClaimJobId: 'job', data: '🙂'.repeat(300) })
    ).toThrow('PAYLOAD_TOO_LARGE');
    expect(requests).toHaveLength(0);
  });

  it('rechecks the execution fence after credentials resolve before issuing the POST', async () => {
    capture(false);
    let release!: (token: string) => void;
    const send = createSingleShotClaimsTransport({
      endpoint,
      getAccessToken: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = send('urm-app-staging', 'user1', { role: 'publisher' }, async () => {
      throw new Error('STALE_EXECUTION');
    });
    release('local-test-token');
    await expect(pending).rejects.toThrow('STALE_EXECUTION');
    expect(requests).toHaveLength(0);
  });

  it.each([
    [400, 'INVALID_ARGUMENT'],
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
  ])('proves a fully consumed structured rejection for %s', async (status, code) => {
    server.on('request', (request, response) => {
      request.resume();
      requests.push({ url: request.url!, body: null });
      response.writeHead(status as number, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: status, status: code, message: 'private detail' } }));
    });
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(send('urm-app-staging', 'user1', { role: 'user' })).rejects.toMatchObject({
      message: 'ACCOUNT_MUTATION_REJECTED',
      rejectionCode: code,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [403, '<html>proxy denied</html>'],
    [400, JSON.stringify({ error: { code: 400, status: 'PERMISSION_DENIED' } })],
  ])('keeps malformed or mismatched rejection %s unknown', async (status, body) => {
    server.on('request', (request, response) => {
      request.resume();
      response.writeHead(status as number);
      response.end(body);
    });
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(send('urm-app-staging', 'user1', { role: 'user' })).rejects.toThrow('RESULT_UNKNOWN');
  });

  it('does not retry a retryable server status', async () => {
    server.on('request', (request, response) => {
      request.resume();
      requests.push({ url: request.url!, body: null });
      response.writeHead(503);
      response.end('unavailable');
    });
    const send = createSingleShotClaimsTransport({ endpoint, getAccessToken: async () => 'local-test-token' });
    await expect(send('urm-app-staging', 'user1', { role: 'user' })).rejects.toThrow('RESULT_UNKNOWN');
    expect(requests).toHaveLength(1);
  });

  it('bounds an accepted POST whose server never responds without retrying', async () => {
    server.on('request', (request) => {
      request.resume();
      requests.push({ url: request.url!, body: null });
    });
    const send = createSingleShotClaimsTransport({
      endpoint,
      timeoutMs: 30,
      getAccessToken: async () => 'local-test-token',
    });
    await expect(send('urm-app-staging', 'user1', { role: 'user' })).rejects.toThrow('RESULT_UNKNOWN');
    expect(requests).toHaveLength(1);
  });
});
