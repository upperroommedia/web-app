import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { executeCanonicalYouTubeAcquisition } from '../../../process-audio/src/temporal/hetzner-acquisition-driver';
import { runYouTubeAcquisitionProcess } from '../../../process-audio/src/temporal/hetzner-acquisition-process';
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-process', () => ({
  runYouTubeAcquisitionProcess: jest.fn(),
}));
const ref = {
  projectId: 'urm-app-staging',
  jobId: 'owned-job',
  sermonId: 'owned-sermon',
  revision: 1,
  requestVersion: 'a'.repeat(16),
};
const originalRelease = process.env.SENTRY_RELEASE;
afterEach(() => {
  if (originalRelease === undefined) delete process.env.SENTRY_RELEASE;
  else process.env.SENTRY_RELEASE = originalRelease;
  jest.clearAllMocks();
});
test('canonical POST resource gate rejects BEFORE database access, reservation mutation or a native fork', async () => {
  process.env.SENTRY_RELEASE = `process-audio-hetzner@staging-${'b'.repeat(40)}`;
  await expect(
    executeCanonicalYouTubeAcquisition({
      firestore: new Proxy(
        {},
        {
          get() {
            throw Error('Unexpected database access');
          },
        }
      ) as never,
      auth: { app: { options: { projectId: ref.projectId } } } as never,
      ref,
      verifiedCallerEmail: 'CONTROLLED_VERIFIED_EMAIL',
      startSignal: new AbortController().signal,
    })
  ).rejects.toThrow('YOUTUBE_SHARED_HOST_RESOURCES_UNAVAILABLE');
  expect(runYouTubeAcquisitionProcess).not.toHaveBeenCalled();
});
test('actual source helper stays inert and malformed IPC cannot initialize Firebase or provider work', async () => {
  const child = fork(resolve(__dirname, '../../../../scripts/integration/fixtures/hetzner-inert-helper.cjs'), [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' },
  });
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  const closed = once(child, 'close');
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  try {
    expect((await once(child, 'message'))[0]).toEqual({ fixture: 'inert-ready', installed: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(1);
    expect(exited).toBe(false);
    child.send({ ref: {}, operationId: 'foreign', directory: '/tmp/foreign', authorized: true });
    expect(await closed).toEqual([1, null]);
    expect(messages).toEqual([{ fixture: 'inert-ready', installed: true }]);
  } finally {
    if (!exited) child.kill('SIGKILL');
    await closed;
  }
});
