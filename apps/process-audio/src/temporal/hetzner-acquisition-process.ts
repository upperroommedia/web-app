import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { isAbsolute } from 'node:path';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId } from './hetzner-acquisition';

const failure = () => new Error('YOUTUBE_ACQUISITION_PROCESS');
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw failure();
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure();
  }
}
async function drainGroup(child: ChildProcess, closed: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    await closed;
    return;
  }
  signalGroup(pid, 'SIGTERM');
  const grace = Date.now() + 5000;
  while (groupAlive(pid) && Date.now() < grace) await pause(25);
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  await closed;
  const deadline = Date.now() + 5000;
  while (groupAlive(pid) && Date.now() < deadline) await pause(25);
  if (groupAlive(pid)) throw failure();
}

/** Private host-only subprocess boundary. The compiled helper path and workspace
 * come from host configuration, never HTTP. It receives only the immutable ref
 * and operation-owned local workspace, loads private inputs itself, and must exit
 * with all descendants drained. No provider output/result enters this API; only a drained execution outcome returns.
 * The caller retains its durable host reservation until this promise settles
 * with a completed/cancelled/failed outcome after confirmed drain. A rejected drain
 * MUST leave that reservation fenced for native reconciliation.
 */
export async function runYouTubeAcquisitionProcess(options: {
  helperPath: string;
  directory: string;
  ref: MediaJobRef;
  signal: AbortSignal;
  /** Host-internal native PID inspection + durable ownership/resource claim.
   * The helper must remain inert until this resolves true. Implementations must
   * honor the supplied cancellation budget and never accept an HTTP boolean.
   */
  authorize: (processId: number, signal: AbortSignal) => Promise<boolean>;
}): Promise<'completed' | 'cancelled' | 'failed'> {
  const ref = Object.freeze({ ...options.ref });
  youtubeAcquisitionId(ref);
  if (process.platform === 'win32' || !isAbsolute(options.helperPath) || !isAbsolute(options.directory))
    throw failure();
  options.signal.throwIfAborted();
  // A fresh POSIX group also contains yt-dlp's ffmpeg/browser descendants. Killing
  // only the direct child is insufficient for safe resource release.
  const child = fork(options.helperPath, [], {
    detached: true,
    silent: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
  });
  let exitCode: number | null = null;
  let spawnFailed = false;
  let stopped: 'cancelled' | 'failed' | undefined;
  let drain: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', (code) => {
      exitCode = code;
      resolve();
    });
  });
  const stop = (reason: 'cancelled' | 'failed') => {
    stopped ??= reason;
    // Retain the actual drain promise; do not claim cancellation from a signal
    // send alone. Attach a handler immediately to avoid an unhandled rejection.
    drain ??= drainGroup(child, closed);
    void drain.catch(() => undefined);
  };
  const abort = () => stop('cancelled');
  options.signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => stop('failed'), 6 * 60 * 60 * 1000);
  deadline.unref();
  try {
    if (options.signal.aborted) abort();
    if (!stopped) {
      const permission = new AbortController();
      const budget = AbortSignal.any([options.signal, permission.signal]);
      const timeout = setTimeout(() => permission.abort(), 10000);
      let abortPermission: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        abortPermission = () => reject(failure());
        budget.addEventListener('abort', abortPermission, { once: true });
        if (budget.aborted) abortPermission();
      });
      try {
        if (!child.pid) throw failure();
        const allowed = await Promise.race([options.authorize(child.pid, budget), cancelled]);
        if (!allowed || budget.aborted || stopped || exitCode !== null || spawnFailed) throw failure();
      } catch {
        if (!stopped) stop(options.signal.aborted ? 'cancelled' : 'failed');
      } finally {
        clearTimeout(timeout);
        if (abortPermission) budget.removeEventListener('abort', abortPermission);
        permission.abort();
      }
    }
    if (!stopped) {
      child.send({ operationId: youtubeAcquisitionId(ref), ref, directory: options.directory }, (error) => {
        if (error) {
          spawnFailed = true;
          stop('failed');
        }
      });
    }
    await closed;
    if (drain) await drain;
    // Even exit0 is invalid if descendants retained the group after helper exit.
    const leaked = child.pid !== undefined && groupAlive(child.pid);
    if (leaked) await drainGroup(child, closed);
    if (stopped) return stopped;
    return spawnFailed || leaked || exitCode !== 0 ? 'failed' : 'completed';
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener('abort', abort);
  }
}
