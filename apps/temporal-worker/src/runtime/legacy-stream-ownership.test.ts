import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import { downloadFile, settleMediaBranches, writeOwnedMediaStream } from '../../../process-audio/src/utils';

jest.mock('../../../process-audio/src/instrument', () => ({
  Sentry: { startSpan: (_: unknown, run: () => unknown) => run() },
}));
jest.mock('../../../process-audio/src/WinstonLogger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, createLoggerWithContext: () => logger };
});

let root: string;
let server: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owned-host-streams-'));
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});
async function listen() {
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (!address || typeof address === 'string') throw Error('Owned local listener missing');
  return `http://127.0.0.1:${address.port}`;
}
test('original loopback HTTP body and file writer finish before download success', async () => {
  server = createServer((_request, response) => {
    response.write(Buffer.alloc(1024, 41));
    setTimeout(() => response.end(Buffer.alloc(1024, 42)), 30);
  });
  const origin = await listen();
  await downloadFile(origin, join(root, 'audio'));
  expect(await readFile(join(root, 'audio'))).toEqual(Buffer.concat([Buffer.alloc(1024, 41), Buffer.alloc(1024, 42)]));
});
test('one parallel failure cancels and joins the original active HTTP body before returning', async () => {
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  server = createServer((_request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(1024));
    response.once('close', closed);
    observed();
  });
  const origin = await listen(),
    token = new CancelToken();
  const failure = Error('CONTROLLED_SIBLING_FAILURE');
  await expect(
    settleMediaBranches(
      [
        () => downloadFile(origin, join(root, 'audio'), token.signal),
        async () => {
          await started;
          let activeWriter = false;
          for (let attempt = 0; attempt < 200; attempt++) {
            try {
              if ((await stat(join(root, 'audio'))).size > 0) {
                activeWriter = true;
                break;
              }
            } catch {
              /* Wait for the original actual file writer. */
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          if (!activeWriter) throw Error('Fixture did not establish an active writer');
          throw failure;
        },
      ],
      token
    )
  ).rejects.toBe(failure);
  expect(token.isCancellationRequested).toBe(true);
  await upstreamClosed;
  const size = (await readFile(join(root, 'audio'))).length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await readFile(join(root, 'audio'))).length).toBe(size);
});
test('destination construction failure still closes its original input stream before rejection', async () => {
  const source = new PassThrough();
  const closed = once(source, 'close');
  let actuallyClosed = false;
  void closed.then(() => {
    actuallyClosed = true;
  });
  await expect(writeOwnedMediaStream(() => source, '\0')).rejects.toThrow();
  expect(actuallyClosed).toBe(true);
});
test('parallel branches preserve input order on success without cancelling the shared token', async () => {
  const token = new CancelToken();
  expect(await settleMediaBranches([async () => 7, async () => 'audio'] as const, token)).toEqual([7, 'audio']);
  expect(token.isCancellationRequested).toBe(false);
});
