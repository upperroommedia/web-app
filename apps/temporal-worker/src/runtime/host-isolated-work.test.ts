import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { runIsolatedLegacyWork } from '../../../process-audio/src/host/isolated';
import { hostResourceRequest } from '../../../process-audio/src/host/resources';
import { CancelToken } from '../../../process-audio/src/CancelToken';
jest.mock('../../../process-audio/src/host/resources', () => ({ hostResourceRequest: jest.fn() }));
jest.mock('node:child_process', () => {
  const actual = jest.requireActual('node:child_process');
  return {
    ...actual,
    fork: jest.fn((path: string, args: string[], options: unknown) => {
      if (!path.endsWith('/host/helper.js')) throw Error('Unexpected helper path');
      return actual.fork(
        require('node:path').resolve(__dirname, '../../../../scripts/integration/fixtures/host-isolated-work.cjs'),
        args,
        options
      );
    }),
  };
});
jest.mock('../../../process-audio/src/instrument', () => ({
  Sentry: { startSpan: (_: unknown, run: () => unknown) => run() },
}));
jest.mock('../../../process-audio/src/WinstonLogger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: logger, createLoggerWithContext: () => logger };
});
let directory: string;
const request = jest.mocked(hostResourceRequest),
  spawn = jest.mocked(fork);
let pid: number | undefined;
const originalCapture = process.env.URM_HOST_CAPTURE,
  originalFixture = process.env.URM_HOST_FIXTURE;
beforeEach(async () => {
  jest.clearAllMocks();
  pid = undefined;
  directory = await mkdtemp(join(tmpdir(), 'owned-host-isolation-'));
  process.env.URM_HOST_CAPTURE = join(directory, 'input');
  delete process.env.URM_HOST_FIXTURE;
  request.mockImplementation(async (id, action, extra) => {
    if (action === 'enroll') {
      pid = extra!.childPid;
      process.kill(pid!, 0);
    }
    if (action === 'close') {
      expect(() => process.kill(-pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }
    return {
      v: 1,
      id,
      peerBound: true,
      directory: `/workspace/host-resource/${id}`,
      state: action === 'reserve' ? 'reserved' : action === 'close' ? 'closed' : 'enrolled',
      ...(action === 'close' ? { groupAbsent: true, receiptHash: 'a'.repeat(64) } : {}),
    };
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (originalCapture === undefined) delete process.env.URM_HOST_CAPTURE;
  else process.env.URM_HOST_CAPTURE = originalCapture;
  if (originalFixture === undefined) delete process.env.URM_HOST_FIXTURE;
  else process.env.URM_HOST_FIXTURE = originalFixture;
});
function input() {
  return {
    projectId: 'urm-app-staging' as const,
    data: { id: 'owned-sermon', storageFilePath: 'sermons/owned.wav', startTime: 0, duration: 1 },
    bucketName: 'urm-app-staging.firebasestorage.app',
    taskId: 'owned-task',
    originalSource: {
      kind: 'storage' as const,
      bucket: 'urm-app-staging.firebasestorage.app',
      path: 'sermons/owned.wav',
      generation: '7',
      timeCreated: '2026-10-20T00:00:00Z',
    },
    ctx: { requestId: 'owned-request', sermonId: 'owned-sermon', operation: 'process-audio' },
    cancelToken: new CancelToken(),
  };
}
test('known native reserve/enroll precede sole IPC, pinned source survives and success waits for original CLOSE and root drain', async () => {
  const value = input();
  const result = await runIsolatedLegacyWork(value);
  expect(result).toEqual({ alreadyProcessed: true, youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' });
  expect(value.ctx).toMatchObject({
    requestId: 'owned-request',
    youtubeCookieRefreshSucceeded: true,
    youtubeSuccessfulAcquisitionAuthority: 'cookie_provider',
  });
  expect(request.mock.calls.map((call) => call[1])).toEqual(['reserve', 'enroll', 'stop', 'close']);
  const original = JSON.parse(await readFile(process.env.URM_HOST_CAPTURE!, 'utf8'));
  expect(original.originalSource).toEqual(value.originalSource);
  expect(original.bucketName).toBe(value.bucketName);
  expect(original.taskId).toBe('owned-task');
  expect(original.ctx.requestId).toBe('owned-request');
});
test('uncertain original closure holds the existing parent until GET-only positive drain readback', async () => {
  const original = request.getMockImplementation()!;
  let observedClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    observedClose = resolve;
  });
  let finish!: (reply: Awaited<ReturnType<typeof hostResourceRequest>>) => void;
  let originalId = '';
  request.mockImplementation(async (id, action, extra) => {
    if (action === 'close') {
      originalId = id;
      observedClose();
      throw Error('CONTROLLED_UNKNOWN_CLOSE_ACK');
    }
    if (action === 'get')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return original(id, action, extra);
  });
  let settled = false;
  const work = runIsolatedLegacyWork(input()).finally(() => {
    settled = true;
  });
  await closing;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(request.mock.calls.map((call) => call[1])).toEqual(['reserve', 'enroll', 'stop', 'close', 'get']);
  finish({ v: 1, id: originalId, state: 'closed', peerBound: true, groupAbsent: true, receiptHash: 'a'.repeat(64) });
  await expect(work).resolves.toMatchObject({ alreadyProcessed: true });
  expect(request.mock.calls.filter((call) => call[1] === 'close')).toHaveLength(1);
});
test('unknown reserve ACK GET reconciles but NEVER forks from saved state', async () => {
  request.mockImplementation(async (id, action) => {
    if (action === 'reserve') throw Error('CONTROLLED_ACK_LOSS');
    return { v: 1, id, state: 'reserved', peerBound: true, directory: `/workspace/host-resource/${id}` };
  });
  await expect(runIsolatedLegacyWork(input())).rejects.toThrow('HOST_ISOLATED_WORK_UNCONFIRMED');
  expect(spawn).not.toHaveBeenCalled();
  expect(request.mock.calls.map((call) => call[1])).toEqual(['reserve', 'get']);
});
test('a leaked descendant requiring root stop cannot become successful business completion', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (id, action, extra) => {
    const reply = await original(id, action, extra);
    return action === 'close' ? { ...reply, descendantsStopped: true } : reply;
  });
  const value = input();
  await expect(runIsolatedLegacyWork(value)).rejects.toThrow('HOST_ISOLATED_WORK_UNCONFIRMED');
  expect(value.ctx).not.toHaveProperty('youtubeSuccessfulAcquisitionAuthority');
});
test('unknown enrollment ACK cannot send execution IPC even when GET says enrolled', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (id, action, extra) => {
    const result = await original(id, action, extra);
    if (action === 'enroll') throw Error('CONTROLLED_ENROLL_ACK_LOSS');
    return result;
  });
  await expect(runIsolatedLegacyWork(input())).rejects.toThrow('HOST_ISOLATED_WORK_UNCONFIRMED');
  await expect(readFile(process.env.URM_HOST_CAPTURE!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(request.mock.calls.filter((call) => call[1] === 'enroll')).toHaveLength(1);
});
test.each(['duplicate', 'private'])(
  '%s provisional child output cannot authorize a successful parent result',
  async (mode) => {
    process.env.URM_HOST_FIXTURE = mode;
    const value = input();
    await expect(runIsolatedLegacyWork(value)).rejects.toThrow();
    expect(value.ctx).not.toHaveProperty('youtubeSuccessfulAcquisitionAuthority');
    expect(request.mock.calls.some((call) => call[1] === 'close')).toBe(true);
  }
);
test('committed root close ACK loss uses GET-only, never repeats cleanup mutation or reforks', async () => {
  const original = request.getMockImplementation()!;
  let completed = false;
  request.mockImplementation(async (id, action, extra) => {
    if (action === 'get' && completed)
      return { v: 1, id, state: 'closed', peerBound: true, groupAbsent: true, receiptHash: 'a'.repeat(64) };
    const result = await original(id, action, extra);
    if (action === 'close') {
      completed = true;
      throw Error('CONTROLLED_CLOSE_ACK_LOSS');
    }
    return result;
  });
  await expect(runIsolatedLegacyWork(input())).resolves.toMatchObject({ alreadyProcessed: true });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter((call) => call[1] === 'close')).toHaveLength(1);
});
