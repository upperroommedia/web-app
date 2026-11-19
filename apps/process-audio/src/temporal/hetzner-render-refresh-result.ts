import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function isTrackedBrowserRefreshId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}

/** The watcher is outside the helper's process group. Only its exact terminal
 * result can settle an attempted refresh after the helper exits. */
export async function readTrackedBrowserRefreshResult(controlDir: string, id: string): Promise<boolean | undefined> {
  if (!isTrackedBrowserRefreshId(id)) return undefined;
  const resultPath = join(controlDir, `refresh-${id}.result.json`);
  try {
    const result = await open(resultPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await result.stat();
      const { size } = stat;
      const buffer = Buffer.alloc(8193);
      if (size === 0 || size >= buffer.length || !stat.isFile()) return undefined;
      const { bytesRead } = await result.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== size) return undefined;
      const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      if (value && typeof value === 'object' && 'ok' in value && typeof value.ok === 'boolean') return value.ok;
      return undefined;
    } finally {
      await result.close();
    }
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return undefined;
    throw error;
  }
}

// Allow an in-flight watcher to publish after the original helper has drained.
// The request's disappearance never proves that the watcher completed.
export async function awaitTrackedBrowserRefreshResult(controlDir: string, id: string): Promise<boolean | undefined> {
  if (!isTrackedBrowserRefreshId(id)) return undefined;
  const deadline = Date.now() + 20_000;
  const base = join(controlDir, `refresh-${id}`);
  const paths = [`${base}.request.json`, `${base}.claimed.json`];
  while (true) {
    const result = await readTrackedBrowserRefreshResult(controlDir, id);
    if (result !== undefined || Date.now() >= deadline) return result;
    // Observe the original name before the watcher-owned name so a rename
    // between checks cannot hide a request still in flight.
    let pending = false;
    for (const file of paths) {
      try {
        await access(file);
        pending = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!pending) return readTrackedBrowserRefreshResult(controlDir, id);
    await delay(500);
  }
}
