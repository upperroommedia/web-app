import { readFile } from 'node:fs/promises';

// The retained YouTube route already uses this same cap for staged objects.
export const YOUTUBE_RENDER_MAX_FILE_BYTES = 20 * 1024 ** 3;

export async function assertNativeYouTubeRenderFileLimit(): Promise<void> {
  const limits = await readFile('/proc/self/limits', 'utf8');
  const file = /^Max file size\s+(\d+)\s+(\d+)\s+bytes\s*$/m.exec(limits);
  if (!file || Number(file[1]) !== YOUTUBE_RENDER_MAX_FILE_BYTES || Number(file[2]) !== YOUTUBE_RENDER_MAX_FILE_BYTES)
    throw new Error('YOUTUBE_RENDER_FILE_LIMIT_UNCONFIRMED');
}
