import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';

/** Cancellation waits for close: cleanup must never race a still-running ffmpeg. */
export function runMediaCommand(
  binary: string,
  args: string[],
  signal: AbortSignal,
  onProgress?: (seconds: number) => void
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-65536);
      progressBuffer += String(chunk);
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (match) onProgress?.(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) reject(signal.reason ?? new Error('Media processing cancelled'));
      else if (spawnError) reject(spawnError);
      // Avoid provider diagnostics / signed source URLs entering workflow history.
      else if (code !== 0)
        reject(
          new Error(`Media command failed (${code}); ${stderr ? 'diagnostics available on worker' : 'no diagnostics'}`)
        );
      else resolve(stdout);
    });
    if (signal.aborted) abort();
  });
}

export const downloadMediaStream = (
  source: Readable,
  destination: string,
  signal: AbortSignal,
  maxBytes = 20 * 1024 ** 3
) => {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error('Audio source exceeds byte budget') : null, chunk);
    },
  });
  return pipeline(source, limit, createWriteStream(destination, { flags: 'wx' }), { signal });
};

export const uploadMediaStream = (source: string, destination: NodeJS.WritableStream, signal: AbortSignal) =>
  pipeline(createReadStream(source), destination, { signal });
