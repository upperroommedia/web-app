import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const endpoint = '/v1/youtube/guest-audio';
const sectionEndpoint = '/v2/youtube/guest-audio-section';
const bodyLimit = 256;
const byteLimit = 200 * 1024 * 1024;
const timeLimit = 120_000;

class RequestFailure extends Error {
  constructor(status) {
    super('Guest audio unavailable');
    this.status = status;
  }
}

class GuestToolExited extends RequestFailure {
  constructor() {
    super(502);
  }
}

function failResponse(res, status) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close' });
  res.end('Guest audio unavailable\n');
}

function validSectionValue(value, limit, allowZero) {
  return typeof value === 'number' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) && !Object.is(value, -0) &&
    value <= limit && (allowZero ? value >= 0 : value > 0);
}

function readAcquisitionRequest(req, signal, section) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    }
    function onError(error) {
      cleanup();
      req.pause();
      reject(error);
    }
    function onAbort() {
      onError(signal.reason);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > bodyLimit) return onError(new RequestFailure(413));
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)) throw new Error();
        if (!section) {
          // A one-member object has no legal comma. Reject duplicate keys.
          if (raw.includes(',') || Object.keys(value).length !== 1) throw new Error();
        } else if (JSON.stringify(value) !== raw || Object.keys(value).sort().join() !== 'durationSeconds,startSeconds,videoId' ||
            !validSectionValue(value.startSeconds, 86_400, true) || !validSectionValue(value.durationSeconds, 3_600, false)) {
          throw new Error();
        }
        resolve(value);
      } catch {
        reject(new RequestFailure(400));
      }
    }
    signal.throwIfAborted();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class GroupCleanupFailure extends RequestFailure {
  constructor() {
    super(503);
  }
}

async function confirmGroupExit(pid) {
  if (!pid) return;
  // A descendant may have closed its pipes before the direct child's close.
  // If the kernel still reports the group, keep the service out of rotation.
  const deadline = performance.now() + 1000;
  do {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw new GroupCleanupFailure();
    }
    await delay(20);
  } while (performance.now() < deadline);
  throw new GroupCleanupFailure();
}

// Run each fixed executable in its own POSIX process group. Its output consumer
// may fail first (size limit, disk error). Always join the native close event.
async function runTool(executable, args, directory, signal, consume) {
  signal.throwIfAborted();
  const child = spawn(executable, args, {
    cwd: directory,
    detached: true,
    env: { HOME: directory, TMPDIR: directory, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let failed = false;
  const closed = new Promise((resolve) => {
    child.once('error', () => { failed = true; });
    child.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
  });
  function killGroup() {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') failed = true;
    }
  }
  // Also stop descendants which keep running after their immediate parent exits.
  child.once('exit', killGroup);
  signal.addEventListener('abort', killGroup, { once: true });
  try {
    await consume(child.stdout);
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) killGroup();
    await closed;
    signal.removeEventListener('abort', killGroup);
    await confirmGroupExit(child.pid);
  }
  signal.throwIfAborted();
  const { code, exitSignal } = await closed;
  if (failed || !child.pid || exitSignal !== null) throw new RequestFailure(502);
  if (code > 0) throw new GuestToolExited();
  if (code !== 0) throw new RequestFailure(502);
}

async function acquire(videoId, file, directory, config, signal) {
  const hash = createHash('sha256');
  let size = 0;
  await runTool(config.ytDlpPath, [
    '--ignore-config', '--no-plugin-dirs', '--no-remote-components',
    '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-playlist',
    '--retries', '0', '--extractor-retries', '0', '--fragment-retries', '0',
    '--max-filesize', String(config.maxBytes), '--fixup', 'never',
    '-f', 'bestaudio[protocol=https]', '-o', '-', '--',
    'https://www.youtube.com/watch?v=' + videoId,
  ], directory, signal, async (stdout) => {
    for await (const chunk of stdout) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > config.maxBytes) throw new RequestFailure(502);
      await file.writeFile(chunk);
      hash.update(chunk);
    }
  });
  if (size === 0 || (await file.stat()).size !== size) throw new RequestFailure(502);
  return { size, digest: hash.digest('hex') };
}

async function acquireSection({ videoId, startSeconds, durationSeconds }, directory, config, signal) {
  const source = join(directory, 'source.audio');
  const file = await open(source, 'wx+', 0o600);
  try {
    await acquire(videoId, file, directory, config, signal);
  } catch (error) {
    // runTool joins the process group before propagating a known exit. The
    // request handler also removes scratch before returning this refusal.
    if (error instanceof GuestToolExited && !signal.aborted) throw new RequestFailure(422);
    throw error;
  } finally {
    await file.close();
  }
  // Seek and encode from the bounded local file. The YouTube stream for the
  // incident source could be downloaded directly, but did not finish remote seeking.
  const path = join(directory, 'section.mka');
  await runTool(config.ffmpegPath, [
    '-nostdin', '-v', 'error', '-xerror', '-ss', String(startSeconds),
    '-protocol_whitelist', 'file', '-i', source, '-t', String(durationSeconds),
    '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', '96k', '-f', 'matroska', '-n', path,
  ], directory, signal, async (stdout) => {
    for await (const _chunk of stdout) signal.throwIfAborted();
  });
  await rm(source);
  const metadata = await lstat(path);
  if (!metadata.isFile() || !boundedInteger(metadata.size, config.maxBytes)) throw new RequestFailure(502);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > config.maxBytes) throw new RequestFailure(502);
    hash.update(chunk);
  }
  if (size !== metadata.size) throw new RequestFailure(502);
  return { path, size, digest: hash.digest('hex') };
}

async function validateAudio(path, directory, ffprobePath, signal, expectedDuration) {
  const chunks = [];
  let size = 0;
  await runTool(ffprobePath, [
    '-v', 'error', '-protocol_whitelist', 'file',
    '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,aac,mp3,flac,wav',
    '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets:format=duration',
    '-of', 'json', path,
  ], directory, signal, async (stdout) => {
    for await (const chunk of stdout) {
      size += chunk.length;
      if (size > 16_384) throw new RequestFailure(502);
      chunks.push(chunk);
    }
  });
  const { streams, format } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const duration = Number(format?.duration);
  const packets = Number(streams?.[0]?.nb_read_packets);
  if (!Array.isArray(streams) || streams.length !== 1 || streams[0].codec_type !== 'audio' ||
      !Number.isSafeInteger(packets) || packets < 1 || !Number.isFinite(duration) || duration <= 0 ||
      (expectedDuration !== undefined && Math.abs(duration - expectedDuration) > 2)) {
    throw new RequestFailure(502);
  }
}

function boundedInteger(value, limit) {
  return Number.isSafeInteger(value) && value >= 1 && value <= limit;
}

export function createGuestAudioServer({
  token, ytDlpPath, ffprobePath, ffmpegPath, scratchRoot = tmpdir(), timeoutMs = timeLimit,
  maxBytes = byteLimit, shutdownSignal,
}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      Buffer.from(token, 'base64url').toString('base64url') !== token ||
      ![ytDlpPath, ffprobePath, scratchRoot, ...(ffmpegPath === undefined ? [] : [ffmpegPath])]
        .every((path) => typeof path === 'string' && isAbsolute(path)) ||
      !boundedInteger(timeoutMs, timeLimit) || !boundedInteger(maxBytes, byteLimit) ||
      process.platform === 'win32') {
    throw new Error('Invalid guest acquisition configuration');
  }
  for (const executable of [ytDlpPath, ffprobePath, ...(ffmpegPath === undefined ? [] : [ffmpegPath])]) {
    if (!statSync(executable).isFile()) throw new Error('Invalid guest executable');
    accessSync(executable, constants.X_OK);
  }
  if (!statSync(scratchRoot).isDirectory()) throw new Error('Invalid guest scratch root');
  accessSync(scratchRoot, constants.W_OK | constants.X_OK);
  const credential = Buffer.from('Bearer ' + token);
  const config = { ytDlpPath, ffmpegPath, maxBytes };
  let busy = false;
  let cleanupFailed = false;
  return createServer({
    maxHeaderSize: 4096, headersTimeout: 10_000, requestTimeout: timeLimit,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 1000,
  }, async (req, res) => {
    const section = req.url === sectionEndpoint;
    if (section ? !ffmpegPath : req.url !== endpoint) return failResponse(res, 404);
    if (req.method !== 'POST') return failResponse(res, 405);
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.headersDistinct.authorization?.length !== 1 || auth.length !== credential.length ||
        !timingSafeEqual(auth, credential)) return failResponse(res, 401);
    if (req.headersDistinct['content-type']?.length !== 1 ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
        req.headers['content-encoding']) return failResponse(res, 415);
    if (Number(req.headers['content-length']) > bodyLimit) return failResponse(res, 413);
    if (cleanupFailed || shutdownSignal?.aborted) return failResponse(res, 503);
    if (busy) return failResponse(res, 429);
    busy = true;
    const controller = new AbortController();
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (shutdownSignal) signals.push(shutdownSignal);
    const signal = AbortSignal.any(signals);
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnect);
    let directory;
    let file;
    let failure;
    try {
      const input = await readAcquisitionRequest(req, signal, section);
      directory = await mkdtemp(join(scratchRoot, 'moses-guest-'));
      let artifact;
      if (section) {
        artifact = await acquireSection(input, directory, config, signal);
      } else {
        const path = join(directory, 'audio');
        file = await open(path, 'wx+', 0o600);
        artifact = { path, ...await acquire(input.videoId, file, directory, config, signal) };
      }
      const { path, size, digest } = artifact;
      await validateAudio(path, directory, ffprobePath, signal, input.durationSeconds);
      signal.throwIfAborted();
      res.writeHead(200, {
        'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream',
        'Content-Length': size, 'X-Content-SHA256': digest,
        ...(section && { 'X-Section-Start-Seconds': String(input.startSeconds), 'X-Section-Duration-Seconds': String(input.durationSeconds) }),
      });
      await pipeline(createReadStream(path), res, { signal });
    } catch (error) {
      if (error instanceof GroupCleanupFailure) {
        cleanupFailed = true;
        console.error('Guest subprocess cleanup failed');
      }
      failure = signal.reason?.name === 'TimeoutError' ? 504 : error.status ?? 502;
    } finally {
      res.off('close', disconnect);
      try {
        await file?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
        failure = 503;
        console.error('Guest scratch cleanup failed');
      }
      busy = false;
    }
    if (failure === 422 && signal.aborted) {
      failure = signal.reason?.name === 'TimeoutError' ? 504 : 503;
    }
    if (failure) failResponse(res, failure);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.MOSES_GUEST_PORT ?? 8791);
    if (!boundedInteger(port, 65_535)) throw new Error();
    const shutdown = new AbortController();
    const ffprobePath = process.env.MOSES_GUEST_FFPROBE_PATH;
    const server = createGuestAudioServer({
      token: process.env.MOSES_GUEST_TOKEN,
      ytDlpPath: process.env.MOSES_GUEST_YTDLP_PATH,
      ffprobePath,
      ffmpegPath: process.env.MOSES_GUEST_FFMPEG_PATH ?? (ffprobePath && join(dirname(ffprobePath), 'ffmpeg')),
      scratchRoot: process.env.MOSES_GUEST_SCRATCH_ROOT,
      shutdownSignal: shutdown.signal,
    });
    function stop() {
      shutdown.abort();
      server.close();
      server.closeAllConnections();
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.listen(port, '127.0.0.1');
  } catch {
    console.error('Invalid guest acquisition configuration');
    process.exitCode = 1;
  }
}
