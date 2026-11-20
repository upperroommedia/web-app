import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { CRC32C, type Bucket } from '@google-cloud/storage';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import mergeFiles from '../../../process-audio/src/mergeFiles';

jest.mock('../../../process-audio/src/utils', () => ({
  ...jest.requireActual('../../../process-audio/src/utils'),
  getFFmpegPath: () => 'fixture-ffmpeg',
}));
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));

test('a failed merge upload cancels its FFmpeg and waits for the original close', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = jest.fn();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill });
  jest.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

  const upload = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('fixture upload rejected'));
    },
  });
  const bucket = {
    file: () => ({ createWriteStream: () => upload }),
  } as unknown as Bucket;
  const token = new CancelToken();
  const temporaryFiles = new Set<string>();
  const progress = { set: jest.fn().mockResolvedValue(undefined) };
  const settled = jest.fn();
  const result = mergeFiles(
    token,
    bucket,
    ['/tmp/test-intro.mp3', '/tmp/test-audio.mp3'],
    'fixture.mp3',
    2,
    temporaryFiles,
    progress,
    { duration: 2 }
  ).then(
    () => settled('success'),
    (error: unknown) => settled(error)
  );

  try {
    stdout.write('fixture audio');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(upload.destroyed).toBe(true);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    child.emit('close', null, 'SIGTERM');
    stderr.destroy();
    await result;
    await Promise.all([...temporaryFiles].map((path) => rm(path, { force: true })));
  }
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture upload rejected' }));
  expect(progress.set).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'completed' }));
});

test('successful upload alone cannot commit a failed FFmpeg merge', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: jest.fn() });
  jest.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const upload = new Writable({ write: (_chunk, _encoding, done) => done() });
  const createWriteStream = jest.fn(() => upload);
  const bucket = { file: () => ({ createWriteStream }) } as unknown as Bucket;
  const temporaryFiles = new Set<string>();
  const progress = { set: jest.fn().mockResolvedValue(undefined) };
  const settled = jest.fn();
  const result = mergeFiles(
    new CancelToken(),
    bucket,
    ['/tmp/test-audio.mp3'],
    'fixture.mp3',
    2,
    temporaryFiles,
    progress,
    { duration: 2 },
    undefined,
    { attemptId: 'fixture-attempt' }
  ).then(
    () => settled('success'),
    (error: unknown) => settled(error)
  );
  try {
    stdout.end('fixture audio');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(upload.writableFinished).toBe(true);
    expect(createWriteStream).toHaveBeenCalledWith(
      expect.objectContaining({
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: expect.objectContaining({ metadata: { duration: 2, attemptId: 'fixture-attempt' } }),
      })
    );
    expect(settled).not.toHaveBeenCalled();
  } finally {
    child.emit('close', 1, null);
    stderr.destroy();
    await result;
    await Promise.all([...temporaryFiles].map((path) => rm(path, { force: true })));
  }
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: 'FFmpeg process exited with code 1' }));
  expect(progress.set).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'completed' }));
});

test('an owned merge checks authority before opening Storage and drains the original FFmpeg on denial', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = jest.fn();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill });
  jest.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const createWriteStream = jest.fn();
  const bucket = { file: () => ({ createWriteStream }) } as unknown as Bucket;
  const tempFiles = new Set<string>();
  const authorize = jest.fn().mockRejectedValue(new Error('fixture render authority changed'));
  const settled = jest.fn();
  const result = mergeFiles(
    new CancelToken(),
    bucket,
    ['/tmp/test-audio.mp3'],
    'fixture.mp3',
    2,
    tempFiles,
    { set: jest.fn().mockResolvedValue(undefined) },
    { duration: 2 },
    undefined,
    { attemptId: 'fixture-attempt' },
    authorize
  ).then(() => settled('success'), settled);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(createWriteStream).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).not.toHaveBeenCalled();
  } finally {
    child.emit('close', null, 'SIGTERM');
    stdout.destroy();
    stderr.destroy();
    await result;
    await Promise.all([...tempFiles].map((path) => rm(path, { force: true })));
  }
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture render authority changed' }));
});

test.each([0, 1])('lost merge acknowledgement still requires native FFmpeg CLOSE (exit %s)', async (code) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: jest.fn() });
  jest.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const raw = Buffer.from('fixture media');
  const crc = new CRC32C();
  crc.update(raw);
  const generation = '1780000000000001';
  const bucketName = 'urm-app-staging.firebasestorage.app';
  const filename = 'lost-ack.mp3';
  const createWriteStream = jest.fn(
    (_options: Parameters<ReturnType<Bucket['file']>['createWriteStream']>[0]) =>
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
        final(done) {
          done(Object.assign(new Error('fixture lost response'), { code: 'ECONNRESET' }));
        },
      })
  );
  const getMetadata = jest.fn(async () => [
    {
      bucket: bucketName,
      name: filename,
      contentType: 'audio/mpeg',
      generation,
      size: String(raw.length),
      crc32c: crc.toString(),
      metadata: createWriteStream.mock.calls[0][0]!.metadata!.metadata,
    },
  ]);
  const bucket = { name: bucketName, file: () => ({ createWriteStream, getMetadata }) } as unknown as Bucket;
  const tempFiles = new Set<string>();
  const recordOutput = jest.fn();
  const settled = jest.fn();
  const result = mergeFiles(
    new CancelToken(),
    bucket,
    ['/tmp/test-audio.mp3'],
    filename,
    2,
    tempFiles,
    { set: jest.fn().mockResolvedValue(undefined) },
    { duration: 2 },
    undefined,
    { attemptId: 'fixture-attempt' },
    async () => undefined,
    recordOutput
  ).then(() => settled('success'), settled);
  try {
    stdout.end(raw);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createWriteStream).toHaveBeenCalledTimes(1);
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(recordOutput).toHaveBeenCalledWith(generation);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    child.emit('close', code, null);
    stderr.destroy();
    await result;
    await Promise.all([...tempFiles].map((path) => rm(path, { force: true })));
  }
  expect(settled).toHaveBeenCalledWith(
    code === 0 ? 'success' : expect.objectContaining({ message: 'FFmpeg process exited with code 1' })
  );
});
