import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const invalid = () => new Error('YOUTUBE_RENDER_PROFILE_UNCONFIRMED');
const profileSnapshot = new AsyncLocalStorage<{
  directory: string;
  browser: 'chrome' | 'chromium';
  cookieDigest: string;
}>();
export const activeRenderProfileSnapshot = () => profileSnapshot.getStore();

function configuredBrowser() {
  return process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER?.trim()?.toLowerCase() === 'chrome' ? 'chrome' : 'chromium';
}

const snapshotName = 'extractor-profile';
const maxBytes = 32 * 1024 ** 2;
const fileStamp = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

async function namedFileStamp(file: string, optional: boolean): Promise<string | null> {
  try {
    const stat = await lstat(file, { bigint: true });
    if (!stat.isFile()) throw invalid();
    return fileStamp(stat);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid();
  }
}

async function databaseDigest(
  file: string,
  signal: AbortSignal,
  optional: boolean,
  copy?: Awaited<ReturnType<typeof open>>
) {
  let fd: Awaited<ReturnType<typeof open>>;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid();
  }
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes) || (!optional && before.size === 0n)) throw invalid();
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < Number(before.size)) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (bytesRead === 0) throw invalid();
      digest.update(buffer.subarray(0, bytesRead));
      if (copy) {
        let written = 0;
        while (written < bytesRead) {
          signal.throwIfAborted();
          const { bytesWritten } = await copy.write(buffer, written, bytesRead - written, offset + written);
          if (bytesWritten === 0) throw invalid();
          written += bytesWritten;
        }
      }
      offset += bytesRead;
    }
    const original = await fd.stat({ bigint: true });
    const stamp = fileStamp(before);
    if (stamp !== fileStamp(original) || stamp !== (await namedFileStamp(file, false))) throw invalid();
    return [stamp, digest.digest('hex')];
  } finally {
    await fd.close();
  }
}

/** Local observation only. No cookie bytes or filesystem path leave the host.
 * Include SQLite's WAL so a committed browser mutation invalidates the result. */
export function readRenderProfileSeal(signal: AbortSignal): Promise<string> {
  return observeProfile(signal, configuredBrowser()).then(({ seal }) => seal);
}

async function observeProfile(
  signal: AbortSignal,
  browser: 'chrome' | 'chromium',
  copy?: Awaited<ReturnType<typeof open>>
): Promise<{ seal: string; cookieDigest: string }> {
  const configured = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR?.trim();
  if (!configured || !isAbsolute(configured) || (await realpath(configured)) !== configured) throw invalid();
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const root = await open(configured, directoryFlags).catch(() => {
    throw invalid();
  });
  const sameDirectory = (a: BigIntStats, b: BigIntStats) =>
    a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  // On the Hetzner Linux worker, every child path resolves from a held
  // descriptor even if the host replaces one of the named directories.
  const directoryPath = (handle: Awaited<ReturnType<typeof open>>, fallback: string) =>
    process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback;
  try {
    const rootIdentity = await root.stat({ bigint: true });
    const namedProfile = join(configured, 'Default');
    const profileUnderRoot = join(directoryPath(root, configured), 'Default');
    const profile = await open(profileUnderRoot, directoryFlags).catch(() => {
      throw invalid();
    });
    try {
      const location = await profile.stat({ bigint: true });
      const anchoredProfile = directoryPath(profile, namedProfile);
      const cookieFile = join(anchoredProfile, 'Cookies');
      const walFile = join(anchoredProfile, 'Cookies-wal');
      const [initialCookies, initialWal] = await Promise.all([
        namedFileStamp(cookieFile, false),
        namedFileStamp(walFile, true),
      ]);
      const cookies = await databaseDigest(cookieFile, signal, false, copy);
      const wal = await databaseDigest(walFile, signal, true);
      // Cookies and WAL form one SQLite snapshot. An individually stable file
      // can still have changed while its companion was being read.
      const [finalCookies, finalWal] = await Promise.all([
        namedFileStamp(cookieFile, false),
        namedFileStamp(walFile, true),
      ]);
      if (
        initialCookies !== cookies?.[0] ||
        finalCookies !== initialCookies ||
        initialWal !== (wal?.[0] ?? null) ||
        finalWal !== initialWal
      )
        throw invalid();
      const [currentRoot, currentProfile] = await Promise.all([
        lstat(configured, { bigint: true }),
        lstat(profileUnderRoot, { bigint: true }),
      ]);
      signal.throwIfAborted();
      if (!sameDirectory(rootIdentity, currentRoot) || !sameDirectory(location, currentProfile)) throw invalid();
      return {
        seal: createHash('sha256')
          .update(
            JSON.stringify(['extractor-main-db-v2', browser, String(location.dev), String(location.ino), cookies, wal])
          )
          .digest('hex'),
        cookieDigest: cookies![1],
      };
    } finally {
      await profile.close();
    }
  } catch {
    signal.throwIfAborted();
    throw invalid();
  } finally {
    await root.close();
  }
}

/** yt-dlp searches the supplied directory recursively and copies only Cookies.
 * Give it exactly the main DB bytes observed in the authorized generation,
 * outside the shared browser writer's directory. The WAL remains in the
 * generation observation so checkpoint or pending-cookie changes are detected.
 */
export async function withRenderProfileSnapshot<T>(
  workspace: string,
  expected: string,
  signal: AbortSignal,
  work: () => Promise<T>
): Promise<T> {
  const browser = configuredBrowser();
  const directory = join(workspace, snapshotName);
  let created = false;
  try {
    let cookieDigest: string;
    try {
      signal.throwIfAborted();
      if (!isAbsolute(workspace) || (await realpath(workspace)) !== workspace || !/^[a-f0-9]{64}$/.test(expected))
        throw invalid();
      await mkdir(directory, { mode: 0o700 });
      created = true;
      const copy = await open(join(directory, 'Cookies'), 'wx', 0o400);
      try {
        const observed = await observeProfile(signal, browser, copy);
        if (observed.seal !== expected) throw invalid();
        cookieDigest = observed.cookieDigest;
      } finally {
        await copy.close();
      }
      signal.throwIfAborted();
    } catch {
      throw invalid();
    }
    return await profileSnapshot.run({ directory, browser, cookieDigest }, work);
  } finally {
    if (created) await removeRenderProfileSnapshot(workspace);
  }
}

export async function requireRenderCookieSnapshot(signal: AbortSignal): Promise<string> {
  const snapshot = activeRenderProfileSnapshot();
  if (!snapshot || snapshot.browser !== 'chrome') throw invalid();
  const observed = await databaseDigest(join(snapshot.directory, 'Cookies'), signal, false);
  if (observed?.[1] !== snapshot.cookieDigest) throw invalid();
  signal.throwIfAborted();
  return snapshot.cookieDigest;
}

/** Parent fallback after positive native CLOSE and descendant drain. Only the
 * reserved directory and its one regular credential file can be removed. */
export async function removeRenderProfileSnapshot(workspace: string) {
  const directory = join(workspace, snapshotName);
  let identity: BigIntStats;
  try {
    identity = await lstat(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!identity.isDirectory() || (await realpath(directory)) !== directory) throw invalid();
  const cookies = join(directory, 'Cookies');
  if ((await namedFileStamp(cookies, true)) !== null) await unlink(cookies);
  await rmdir(directory);
}
