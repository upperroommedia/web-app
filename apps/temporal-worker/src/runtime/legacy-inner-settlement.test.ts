import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { downloadFiles, createTempFile, getDurationSeconds } from '../../../process-audio/src/utils';
import { once } from 'node:events';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import trimAndTranscode from '../../../process-audio/src/trimAndTranscode';
import { processAudio, renderProcessAudio } from '../../../process-audio/src/processAudio';
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
  settleMediaBranches: jest.requireActual('../../../process-audio/src/utils').settleMediaBranches,
  writeOwnedMediaStream: jest.requireActual('../../../process-audio/src/utils').writeOwnedMediaStream,
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

test('actual FULLpipeline retains lock and files when Storage construction throws while sibling original stream closes later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-parallel-stream-'));
  const token = new CancelToken(),
    input = new PassThrough();
  const output = createWriteStream(join(root, 'owned-audio'));
  let closed = false;
  const original = pipeline(input, output).finally(() => {
    closed = true;
  });
  void original.catch(() => undefined);
  input.write(Buffer.alloc(1024));
  token.signal.addEventListener('abort', () => setTimeout(() => input.end(), 100), { once: true });
  const cleanup: boolean[] = [];
  const state = new Map<string, unknown>();
  const database = {
    ref: (key: string) => ({
      transaction: async (fn: (current: any) => unknown) => {
        const next = fn(state.get(key));
        if (next === null) cleanup.push(closed);
        if (next !== undefined) state.set(key, next);
        return { committed: next !== undefined, snapshot: { val: () => state.get(key) } };
      },
      remove: async () => {
        cleanup.push(closed);
      },
    }),
  };
  jest.mocked(trimAndTranscode).mockResolvedValue({} as never);
  jest.mocked(downloadFiles).mockImplementation(async () => {
    await original;
    return {};
  });
  jest.mocked(createTempFile).mockReturnValue(join(root, 'processed-audio'));
  try {
    await expect(
      processAudio(
        'CONTROLLED_NO_VENDOR',
        token,
        {
          file: () => ({
            createReadStream: () => {
              throw Error('CONTROLLED_STORAGE_CONSTRUCTOR_FAILURE');
            },
          }),
        } as never,
        database as never,
        {} as never,
        { id: 'owned-stream-sermon', type: 'StorageFilePath', source: 'processed-sermons/owned' },
        {
          path: 'sermons/owned-stream-sermon',
          get: async () => ({ exists: true, data: () => ({ title: 'Synthetic', status: {} }) }),
          update: async () => undefined,
        } as never,
        {} as never,
        0,
        1
      )
    ).rejects.toThrow('CONTROLLED_STORAGE_CONSTRUCTOR_FAILURE');
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup.every(Boolean)).toBe(true);
    expect(closed).toBe(true);
  } finally {
    token.cancel();
    input.end();
    await original;
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['exact', 'wrong generation', 'insufficient workspace'])(
  'generation-pinned render reserves the measured inputs before reading them (%s)',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'owned-pinned-merge-'));
    const path = join(root, 'processed-audio');
    const token = new CancelToken();
    const resources = await import('../../../process-audio/src/temporal/resources');
    const capacity = jest.spyOn(resources, 'assertRetainedMediaWorkspaceAvailable');
    if (scenario === 'insufficient workspace') capacity.mockRejectedValueOnce(new Error('CONTROLLED_WORKSPACE_FULL'));
    jest.mocked(createTempFile).mockReturnValue(path);
    jest.mocked(getDurationSeconds).mockResolvedValue(1);
    jest.mocked(trimAndTranscode).mockImplementation(async (...args) => {
      args[19]?.('123');
      return {} as never;
    });
    const read = jest.fn(() => {
      expect(capacity).toHaveBeenCalledWith(root, [5]);
      const input = new PassThrough();
      input.end(Buffer.alloc(5));
      return input;
    });
    const file = jest.fn(() => ({
      getMetadata: async () => [{ size: '5', generation: scenario === 'wrong generation' ? '124' : '123' }],
      createReadStream: read,
    }));
    try {
      const result = renderProcessAudio({
        ytdlpPath: 'CONTROLLED_NO_VENDOR',
        cancelToken: token,
        bucket: { file } as never,
        audioSource: { type: 'YouTubeUrl', id: 'fixture', source: 'https://www.youtube.com/watch?v=abcdefghijk' },
        realtimeDB: {} as never,
        progressRef: { set: async () => undefined },
        updateSermon: async () => undefined,
        sermonStatus: {} as never,
        contextWithSermonId: { sermonId: 'fixture' } as never,
        processedStoragePath: 'owned-processed',
        outputFilePath: 'owned-merged',
        outputIdentity: { jobId: 'fixture' },
        pinnedMergeSources: {},
        tempFiles: new Set(),
      });
      if (scenario === 'exact') {
        await expect(result).resolves.toMatchObject({ generations: { processed: '123' }, processedDuration: 1 });
        expect(read).toHaveBeenCalledWith({ validation: 'crc32c', decompress: false });
        expect((await readFile(path)).length).toBe(5);
      } else {
        await expect(result).rejects.toThrow(
          scenario === 'wrong generation' ? 'Pinned media metadata' : 'CONTROLLED_WORKSPACE_FULL'
        );
        expect(read).not.toHaveBeenCalled();
      }
      expect(file).toHaveBeenCalledWith('owned-processed', { generation: '123' });
    } finally {
      token.cancel();
      capacity.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
);
