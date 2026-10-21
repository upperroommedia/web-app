import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import trimAndTranscode from '../../../process-audio/src/trimAndTranscode';
import { processAudio } from '../../../process-audio/src/processAudio';
jest.mock('../../../process-audio/src/trimAndTranscode', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../process-audio/src/trim', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../process-audio/src/mergeFiles', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../process-audio/src/instrument', () => ({
  Sentry: { startSpan: (_: unknown, run: () => unknown) => run() },
}));
jest.mock('../../../process-audio/src/WinstonLogger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, createLoggerWithContext: () => logger };
});
jest.mock('../../../process-audio/src/utils', () => ({
  logMemoryUsage: jest.fn(),
  secondsToTimeFormat: jest.fn(),
  downloadFiles: jest.fn(),
  getDurationSeconds: jest.fn(),
  createTempFile: jest.fn(),
  unlinkSafeTempFile: jest.fn(),
}));
jest.mock('../../../process-audio/src/processAudioQueueStore', () => ({ markProcessAudioRequestRunning: jest.fn() }));
jest.mock('../../../process-audio/src/processAudioProgress', () => ({ setProcessAudioProgress: jest.fn() }));
test('actual legacy processAudio retains its own sermon lock and temp cleanup until tracked native CLOSE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-inner-pipeline-'));
  const path = join(root, 'child.cjs');
  await writeFile(
    path,
    'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150)); process.send({ready:true}); setInterval(() => {}, 1000);'
  );
  const token = new CancelToken();
  let child: ChildProcess | undefined,
    close: Promise<void> | undefined,
    closed = false;
  const cleanupClosed: boolean[] = [];
  const state = new Map<string, unknown>();
  const database = {
    ref: (key: string) => ({
      transaction: async (fn: (current: any) => unknown) => {
        const next = fn(state.get(key));
        if (next === null) cleanupClosed.push(closed);
        if (next !== undefined) state.set(key, next);
        return { committed: next !== undefined, snapshot: { val: () => state.get(key) } };
      },
      remove: async () => {
        cleanupClosed.push(closed);
        state.delete(key);
      },
    }),
  };
  jest.mocked(trimAndTranscode).mockImplementation(async (_path, actualToken) => {
    child = fork(path, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    actualToken.trackProcess(child);
    close = once(child, 'close').then(() => {
      closed = true;
    });
    await once(child, 'message');
    throw Error('CONTROLLED_EARLY_CHILD_PIPE_FAILURE');
  });
  try {
    await expect(
      processAudio(
        'CONTROLLED_NO_VENDOR',
        token,
        {} as never,
        database as never,
        {} as never,
        { id: 'owned-native-sermon', type: 'StorageFilePath', source: 'processed-sermons/owned' },
        {
          path: 'sermons/owned-native-sermon',
          get: async () => ({ exists: true, data: () => ({ title: 'Synthetic', status: {} }) }),
          update: async () => undefined,
        } as never,
        {} as never,
        0,
        1
      )
    ).rejects.toThrow('CONTROLLED_EARLY_CHILD_PIPE_FAILURE');
    expect(cleanupClosed.length).toBeGreaterThan(0);
    expect(cleanupClosed.every(Boolean)).toBe(true);
    expect(closed).toBe(true);
  } finally {
    token.cancel();
    if (child && !closed) child.kill('SIGKILL');
    await close;
    await token.waitForProcesses();
    await rm(root, { recursive: true, force: true });
  }
});
