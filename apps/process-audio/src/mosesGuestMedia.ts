import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const mosesGuestMediaInputArgs = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,aac,mp3,flac,wav',
] as const;

const run = promisify(execFile);

export async function verifyMosesGuestAudio(file: string, ffprobePath: () => string, expectedDuration?: number): Promise<boolean> {
  try {
    const { stdout } = await run(ffprobePath(), [
      '-v', 'error', ...mosesGuestMediaInputArgs, '-count_packets',
      '-show_entries', 'stream=codec_type,nb_read_packets:format=duration', '-of', 'json', file,
    ], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16_384 });
    const { streams, format } = JSON.parse(stdout);
    const packets = Number(streams?.[0]?.nb_read_packets);
    const duration = Number(format?.duration);
    return Array.isArray(streams) && streams.length === 1 && streams[0].codec_type === 'audio' &&
      Number.isSafeInteger(packets) && packets > 0 && Number.isFinite(duration) && duration > 0 &&
      (expectedDuration === undefined || (Number.isFinite(expectedDuration) && expectedDuration > 0 &&
        Math.abs(duration - expectedDuration) <= 2));
  } catch {
    return false;
  }
}
