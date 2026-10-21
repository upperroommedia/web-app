import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runMediaCommand } from '../../../process-audio/src/temporal/native';

const rate = 16000,
  samples = 16000;
const fail = (): never => {
  throw new Error('MEDIA_NATIVE_PROCESSING_CANARY_UNCONFIRMED');
};
export const MEDIA_STARTUP_CANARY_KIND = 'filesystem-allocation-and-native-audio-v3';
export interface NativeMediaProcessingEvidence {
  schemaVersion: 1;
  ffmpegSHA256: string;
  ffprobeSHA256: string;
  sourceBytes: number;
  outputBytes: number;
  sampleRate: 16000;
  channels: 1;
  durationSeconds: number;
  pcmSamplesVerified: 16000;
  progressBeforeCancellation: true;
  cancelledChildDrained: true;
  retryCompleted: true;
}
function wave() {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return bytes;
}
async function binaryDigest(path: string, signal: AbortSignal, rootOwned: boolean) {
  if (!isAbsolute(path)) fail();
  const actual = await realpath(path),
    before = await stat(actual);
  if (rootOwned && (actual !== path || before.uid !== 0 || (before.mode & 0o022) !== 0)) fail();
  if (!before.isFile() || before.size < 1 || before.size > 256 * 1024 ** 2) fail();
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(actual, { signal })) {
    size += chunk.length;
    if (size > 256 * 1024 ** 2) fail();
    hash.update(chunk);
  }
  const after = await stat(actual);
  if (
    size !== before.size ||
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  )
    fail();
  return { path: actual, digest: hash.digest('hex') };
}
function verifyPcm(bytes: Buffer, source: Buffer) {
  if (
    bytes.length > 65536 ||
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  )
    fail();
  let offset = 12,
    format = false,
    data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      end = offset + 8 + size;
    if (end > bytes.length) fail();
    if (name === 'fmt ') {
      if (
        format ||
        size < 16 ||
        bytes.readUInt16LE(offset + 8) !== 1 ||
        bytes.readUInt16LE(offset + 10) !== 1 ||
        bytes.readUInt32LE(offset + 12) !== rate ||
        bytes.readUInt16LE(offset + 22) !== 16
      )
        fail();
      format = true;
    }
    if (name === 'data') {
      if (data || size !== samples * 2) fail();
      data = bytes.subarray(offset + 8, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !data || offset !== bytes.length) return fail();
  for (let i = 0; i < samples; i++)
    if (Math.abs(data.readInt16LE(i * 2) - source.readInt16LE(44 + i * 2) / 2) > 1) fail();
}

/** Only the caller-owned startup workspace and fixed synthetic audio are used.
 * Production selects the immutable image's exact executable paths. Test callers
 * may select installed local binaries; that is not pinned-image evidence. */
export async function runNativeMediaProcessingCanary(options: {
  directory: string;
  signal: AbortSignal;
  ffmpeg?: string;
  ffprobe?: string;
}): Promise<NativeMediaProcessingEvidence> {
  const end = Date.now() + 8000,
    signal = AbortSignal.any([options.signal, AbortSignal.timeout(8000)]);
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() > end) fail();
  };
  try {
    check();
    const ffmpeg = await binaryDigest(options.ffmpeg ?? '/usr/local/bin/ffmpeg', signal, options.ffmpeg === undefined);
    check();
    const ffprobe = await binaryDigest(
      options.ffprobe ?? '/usr/local/bin/ffprobe',
      signal,
      options.ffprobe === undefined
    );
    check();
    const source = wave(),
      input = join(options.directory, 'source.wav'),
      output = join(options.directory, 'processed.wav');
    await writeFile(input, source, { flag: 'wx', mode: 0o600 });
    check();
    const cancelled = new AbortController(),
      marker = new Error('Owned synthetic media interruption');
    let progressed = false,
      drained = false;
    try {
      await runMediaCommand(
        ffmpeg.path,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'file',
          '-stream_loop',
          '-1',
          '-re',
          '-i',
          input,
          '-threads',
          '1',
          '-filter_threads',
          '1',
          '-progress',
          'pipe:1',
          '-stats_period',
          '0.1',
          '-f',
          'null',
          '-',
        ],
        AbortSignal.any([signal, cancelled.signal]),
        (seconds) => {
          if (seconds > 0 && !progressed) {
            progressed = true;
            cancelled.abort(marker);
          }
        }
      );
    } catch (error) {
      if (error !== marker || !progressed || !cancelled.signal.aborted) fail();
      drained = true;
    }
    check();
    if (!drained) fail();
    await runMediaCommand(
      ffmpeg.path,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file',
        '-i',
        input,
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-af',
        'volume=0.5',
        '-c:a',
        'pcm_s16le',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-bitexact',
        '-n',
        output,
      ],
      signal
    );
    check();
    const metadata = await stat(output);
    if (!metadata.isFile() || metadata.size > 65536) fail();
    const processed = await readFile(output);
    check();
    verifyPcm(processed, source);
    const report = JSON.parse(
      await runMediaCommand(
        ffprobe.path,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file',
          '-show_entries',
          'format=duration:stream=codec_name,sample_rate,channels',
          '-of',
          'json',
          output,
        ],
        signal
      )
    );
    check();
    const stream = report?.streams?.[0],
      duration = Number(report?.format?.duration);
    if (
      !Array.isArray(report?.streams) ||
      report.streams.length !== 1 ||
      stream?.codec_name !== 'pcm_s16le' ||
      stream.sample_rate !== String(rate) ||
      stream.channels !== 1 ||
      !Number.isFinite(duration) ||
      Math.abs(duration - 1) > 0.005
    )
      fail();
    return {
      schemaVersion: 1,
      ffmpegSHA256: ffmpeg.digest,
      ffprobeSHA256: ffprobe.digest,
      sourceBytes: source.length,
      outputBytes: processed.length,
      sampleRate: 16000,
      channels: 1,
      durationSeconds: duration,
      pcmSamplesVerified: 16000,
      progressBeforeCancellation: true,
      cancelledChildDrained: true,
      retryCompleted: true,
    };
  } catch {
    return fail();
  }
}
