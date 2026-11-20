import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requireRenderCookieSnapshot } from './hetzner-render-profile';

const denied = () => new Error('YOUTUBE_RENDER_BROWSER_TOKEN_UNCONFIRMED');

async function readBrokerResult(path: string): Promise<unknown> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 17920) throw denied();
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (stat.size !== bytesRead) throw denied();
    return JSON.parse(bytes.toString('utf8', 0, bytesRead));
  } finally {
    await fd.close();
  }
}

/** Only an active pinned Chrome generation may request this local broker.
 * The file protocol carries a digest, never the cookie DB or a caller path.
 */
export async function requestRenderBrowserPoToken(
  videoId: string,
  controlDir: string,
  operationSignal: AbortSignal
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw denied();
  const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(60_000)]);
  const cookieDigest = await requireRenderCookieSnapshot(signal);
  const base = join(controlDir, `pot-${randomUUID().replaceAll('-', '')}.sealed-pot`);
  const pending = base + '.pending';
  const request = base + '.request';
  const result = base + '.result';
  let published = false;
  try {
    await writeFile(pending, JSON.stringify({ videoId, cookieDigest }), { flag: 'wx', mode: 0o600 });
    signal.throwIfAborted();
    await link(pending, request);
    published = true;
    while (true) {
      signal.throwIfAborted();
      try {
        const outcome = await readBrokerResult(result);
        if (!outcome || typeof outcome !== 'object') throw denied();
        const response = outcome as { ok?: unknown; videoId?: unknown; cookieDigest?: unknown; poToken?: unknown };
        if (
          response.ok !== true ||
          response.videoId !== videoId ||
          response.cookieDigest !== cookieDigest ||
          typeof response.poToken !== 'string' ||
          !/^[A-Za-z0-9_=-]{100,16384}$/.test(response.poToken)
        )
          throw denied();
        if ((await requireRenderCookieSnapshot(signal)) !== cookieDigest) throw denied();
        return response.poToken;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw denied();
      }
      await delay(250, undefined, { signal });
    }
  } finally {
    await unlink(pending).catch(() => undefined);
    if (published) await Promise.all([unlink(request).catch(() => undefined), unlink(result).catch(() => undefined)]);
  }
}
