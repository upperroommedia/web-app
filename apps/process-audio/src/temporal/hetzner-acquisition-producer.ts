import { spawn, execFile } from 'node:child_process';
import { readFile, realpath, stat, statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { YouTubeUploadProducer } from './hetzner-acquisition-upload';

const execute = promisify(execFile);
const failure = () => new Error('YOUTUBE_NATIVE_PRODUCER_UNCONFIRMED');
/** Runs INSIDE the already isolated per-operation helper session, never the
 * shared HTTP server. Linux pidfds prevent signalling a reused unrelated PID.
 * The drainer is itself a child of this helper and excludes only itself/root.
 */
const drainScript = String.raw`
import os, sys, signal, time
root, birth = int(sys.argv[1]), sys.argv[2]
def info(pid):
    try:
        with open('/proc/%d/stat' % pid) as f: fields = f.read().rpartition(') ')[2].split()
        return fields[0], int(fields[2]), int(fields[3]), fields[19]
    except FileNotFoundError:
        return None
def owner():
    value = info(root)
    if not value or value[1:] != (root, root, birth): raise RuntimeError('owner changed')
    if os.getppid() != root or os.getpgrp() != root or os.getsid(0) != root: raise RuntimeError('foreign group')
def members():
    owner()
    result = []
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        pid = int(name)
        if pid in (root, os.getpid()): continue
        value = info(pid)
        if value and value[1] == root:
            if value[2] != root: raise RuntimeError('foreign session')
            if value[0] != 'Z': result.append((pid, value))
    return result
def send(pid, before, sig):
    try: fd = os.pidfd_open(pid, 0)
    except ProcessLookupError: return
    try:
        # Recheck after opening the pidfd; never signal a replacement process.
        after = info(pid)
        if after and after[1:] == before[1:]:
            signal.pidfd_send_signal(fd, sig, None, 0)
    except ProcessLookupError: pass
    finally: os.close(fd)
owner()
if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'): raise RuntimeError('pidfd unavailable')
probe = os.pidfd_open(root, 0)
try: signal.pidfd_send_signal(probe, 0, None, 0)
finally: os.close(probe)
initial = members()
end = time.monotonic() + 5
while True:
    current = members()
    if not current: break
    sig = signal.SIGTERM if time.monotonic() < end else signal.SIGKILL
    for pid, before in current: send(pid, before, sig)
    if time.monotonic() > end + 5: raise RuntimeError('drain unknown')
    time.sleep(.025)
print('children' if initial else 'empty')
`;

export interface NativeYouTubeProducer extends YouTubeUploadProducer {
  /** Private bounded diagnostics for the existing auth classifier only. Never
   * return them through HTTP, Temporal history or public status. */
  diagnostic(): string | undefined;
}

/** Native byte producer for the retained acquisition helper. This enforces
 * isolated-session and actual bounded tmpfs prerequisites; the host still must
 * reserve shared memory/resources and authorize the helper before invoking it.
 * No process/byte acquisition may be started by an HTTP payload directly.
 */
export async function startNativeYouTubeProducer(options: {
  binary: string;
  args: string[];
  directory: string;
}): Promise<NativeYouTubeProducer> {
  if (process.platform !== 'linux' || !isAbsolute(options.directory) || !isAbsolute(options.binary)) throw failure();
  const [path, directory, filesystem, self] = await Promise.all([
    realpath(options.directory),
    stat(options.directory),
    statfs(options.directory),
    readFile('/proc/self/stat', 'utf8'),
  ]);
  const fields = self.slice(self.lastIndexOf(') ') + 2).split(' ');
  const birth = fields[19];
  if (
    path !== options.directory ||
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid?.() ||
    Number(fields[2]) !== process.pid ||
    Number(fields[3]) !== process.pid ||
    !/^[1-9][0-9]*$/.test(birth) ||
    filesystem.type !== 0x01021994 ||
    filesystem.blocks * filesystem.bsize > 256 * 1024 ** 2 ||
    filesystem.blocks <= 0 ||
    options.args.some((arg) => typeof arg !== 'string') ||
    options.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 64 * 1024
  )
    throw failure();
  const drain = async (): Promise<boolean> => {
    try {
      const result = await execute('/usr/bin/python3', ['-c', drainScript, String(process.pid), birth], {
        timeout: 12000,
        maxBuffer: 1024,
        cwd: path,
      });
      if (result.stdout.trim() !== 'empty' && result.stdout.trim() !== 'children') throw failure();
      return result.stdout.trim() === 'children';
    } catch {
      throw failure();
    }
  };
  // Verify kernel/pidfd support and absence of leftover attempt processes BEFORE
  // launching a provider. Existing leaked children are drained, then rejected.
  if (await drain()) throw failure();
  const child = spawn(options.binary, options.args, {
    cwd: path,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TMPDIR: path,
      TMP: path,
      TEMP: path,
      DENO_DIR: `${path}/deno`,
      XDG_CACHE_HOME: `${path}/cache`,
      PYTHONPYCACHEPREFIX: `${path}/pycache`,
    },
  });
  let diagnostic = Buffer.alloc(0);
  let truncated = false;
  child.stderr.on('data', (chunk: Buffer) => {
    if (diagnostic.length + chunk.byteLength > 64 * 1024) truncated = true;
    diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 64 * 1024 - diagnostic.length)]);
  });
  let drainResult: Promise<boolean> | undefined;
  const drainOnce = () => (drainResult ??= drain());
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const completion = new Promise<'succeeded' | 'failed'>((resolve, reject) => {
    const finish = (code: number | null) => {
      void drainOnce()
        .then(async (leaked) => {
          await closed;
          resolve(code === 0 && !leaked ? 'succeeded' : 'failed');
        })
        .catch(reject);
    };
    // Exit precedes close: leaked descendants may otherwise retain stdout and
    // prevent close forever. Drain them before waiting for pipe closure.
    child.once('exit', finish);
    child.once('error', () => finish(null));
  });
  void completion.catch(() => undefined);
  return {
    output: child.stdout,
    completion,
    async drain() {
      await drainOnce();
      await closed;
    },
    diagnostic: () => (truncated ? undefined : diagnostic.toString('utf8')),
  };
}

/** Final helper-side native session check. No saved PID or external death boolean.
 * A true return means unexpected descendants were found and drained: callers
 * must reject success even though resource cleanup can continue. */
export async function drainNativeYouTubeSession(directory: string): Promise<boolean> {
  if (process.platform !== 'linux' || !isAbsolute(directory)) throw failure();
  const text = await readFile('/proc/self/stat', 'utf8');
  const fields = text
    .slice(text.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/);
  if (Number(fields[2]) !== process.pid || Number(fields[3]) !== process.pid || !/^[1-9][0-9]*$/.test(fields[19]))
    throw failure();
  const result = await execute('/usr/bin/python3', ['-c', drainScript, String(process.pid), fields[19]], {
    timeout: 12000,
    maxBuffer: 1024,
    cwd: directory,
  });
  if (result.stdout.trim() !== 'empty' && result.stdout.trim() !== 'children') throw failure();
  return result.stdout.trim() === 'children';
}
