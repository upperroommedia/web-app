import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGuestAudioServer } from './acquire.mjs';

const videoId = 'abcdefghijk';
const canonicalUrl = 'https://www.youtube.com/watch?v=' + videoId;
const payload = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));
const route = '/v1/youtube/guest-audio';
const sectionRoute = '/v2/youtube/guest-audio-section';
const sectionBody = JSON.stringify({ videoId, startSeconds: 125.5, durationSeconds: 9.25 });

// Both fake native tools run as children. Their only writable paths are literals
// in this suite's private fixture directory, never paths from command arguments.
async function writeFixture(path, body) {
  const program = [
    '#!' + process.execPath,
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'assert.equal(fs.realpathSync(process.argv[1]), ' + JSON.stringify(path) + ');',
    'const args = process.argv.slice(2);',
    body,
  ].join('\n');
  await writeFile(path, program, { mode: 0o700, flag: 'wx' });
}

async function startFixture(t, mode = 'ok', limits = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urm-guest-audio-test-')));
  const scratch = join(root, 'scratch');
  const marker = join(root, 'started');
  let server;
  t.after(async () => {
    if (server?.listening) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(scratch, { mode: 0o700 });
  const ytDlpPath = join(root, 'fixture-ytdlp.cjs');
  const ffprobePath = join(root, 'fixture-ffprobe.cjs');
  const ffmpegPath = join(root, 'fixture-ffmpeg.cjs');
  const data = "Buffer.from(" + JSON.stringify(payload.toString('base64')) + ", 'base64')";
  const section = mode.startsWith('section-');
  await writeFixture(ytDlpPath, `
    assert.deepEqual(args, [
      '--ignore-config', '--no-plugin-dirs', '--no-remote-components',
      '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-playlist',
      '--retries', '0', '--extractor-retries', '0', '--fragment-retries', '0',
      '--max-filesize', ${JSON.stringify(String(limits.maxBytes ?? 4096))}, '--fixup', 'never',
      '-f', 'bestaudio[protocol=https]', '-o', '-', '--', ${JSON.stringify(canonicalUrl)},
    ]);
    assert.equal(process.env.HOME, process.cwd());
    assert.equal(process.env.TMPDIR, process.cwd());
    assert.equal(process.env.MOSES_GUEST_TOKEN, undefined);
    const marker = ${JSON.stringify(marker)};
    const first = !fs.existsSync(marker);
    fs.appendFileSync(marker, String(process.pid) + '\\n');
    const mode = ${JSON.stringify(mode)};
    if (mode === 'empty') process.exit(0);
    if (mode === 'hang-once' && first) {
      setTimeout(() => process.exit(24), 8000);
    } else {
      const data = ${data};
      process.stdout.write(data.subarray(0, 7));
      setImmediate(() => {
        process.stdout.write(data.subarray(7));
        if (mode === 'partial-exit') {
          process.stderr.write('fixture-private-diagnostic');
          process.exitCode = 7;
        }
      });
    }
  `);
  if (section) await writeFixture(ffmpegPath, `
    const input = path.join(process.cwd(), 'source.audio');
    const output = path.join(process.cwd(), 'section.mka');
    assert.equal(path.dirname(process.cwd()), ${JSON.stringify(scratch)});
    assert.deepEqual(fs.readFileSync(input), ${data});
    assert.deepEqual(args, [
      '-nostdin', '-v', 'error', '-xerror', '-ss', '125.5', '-protocol_whitelist', 'file',
      '-i', input, '-t', '9.25', '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', '96k', '-f', 'matroska', '-n', output,
    ]);
    fs.writeFileSync(output, ${data}, { flag: 'wx' });
  `);
  await writeFixture(ffprobePath, `
    const scratch = ${JSON.stringify(scratch)};
    const input = args.at(-1);
    assert.deepEqual(args, [
      '-v', 'error', '-protocol_whitelist', 'file',
      '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,aac,mp3,flac,wav',
      '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets:format=duration',
      '-of', 'json', path.join(process.cwd(), ${JSON.stringify(section ? 'section.mka' : 'audio')}),
    ]);
    assert.equal(path.dirname(process.cwd()), scratch);
    assert.equal(input, fs.realpathSync(input));
    const stat = fs.lstatSync(input);
    assert.ok(stat.isFile() && stat.size === ${payload.length});
    if (${section}) assert.ok(!fs.existsSync(path.join(process.cwd(), 'source.audio')));
    assert.deepEqual(fs.readFileSync(input), ${data});
    const mode = ${JSON.stringify(mode)};
    if (mode === 'bad-probe') { process.exit(9); }
    const codec_type = mode === 'no-audio' ? 'video' : 'audio';
    const duration = ${section} ? (mode === 'section-wrong-duration' ? '30' : '9.3') : (mode === 'no-duration' ? '0' : '1.5');
    const nb_read_packets = mode === 'no-packets' ? '0' : '1';
    process.stdout.write(JSON.stringify({ streams: [{ codec_type, nb_read_packets }], format: { duration } }));
  `);

  const token = randomBytes(32).toString('base64url');
  server = createGuestAudioServer({
    token, ytDlpPath, ffprobePath, ffmpegPath: section ? ffmpegPath : undefined,
    scratchRoot: scratch, timeoutMs: 5000, maxBytes: 4096, ...limits,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  function post({ body = JSON.stringify({ videoId }), headers = {}, method = 'POST', path = route, signal } = {}) {
    return fetch(origin + path, {
      method, body: method === 'GET' ? undefined : body, signal,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
    });
  }
  return { post, scratch, marker };
}

test('v2 emits only the cookie-free requested section with its native hash and exact range', async t => {
  const { post, scratch } = await startFixture(t, 'section-ok');
  const response = await post({ body: sectionBody, path: sectionRoute });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-section-start-seconds'), '125.5');
  assert.equal(response.headers.get('x-section-duration-seconds'), '9.25');
  assert.equal(response.headers.get('x-content-sha256'), createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  await eventually(async () => (await readdir(scratch)).length === 0, 'Section scratch should close');
});

test('v2 rejects ambiguous numbers and preserves custody when ffprobe finds the wrong duration', async t => {
  const { post, marker, scratch } = await startFixture(t, 'section-wrong-duration');
  for (const body of [
    JSON.stringify({ videoId }),
    sectionBody.replace('125.5', '1.255e2'),
    sectionBody.replace('125.5', '86401'),
    sectionBody.replace('125.5', '-0'),
    sectionBody.replace('9.25', '0'),
    sectionBody.replace('9.25', '3601'),
    sectionBody.replace('9.25', '9.25,"durationSeconds":9.25'),
    sectionBody.replace('9.25', '9.25,"cookies":"not accepted"'),
  ]) {
    const response = await post({ body, path: sectionRoute });
    assert.equal(response.status, 400);
    await response.text();
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const response = await post({ body: sectionBody, path: sectionRoute });
  assert.equal(response.status, 502);
  assert.equal(response.headers.has('x-section-duration-seconds'), false);
  await response.text();
  await eventually(async () => (await readdir(scratch)).length === 0, 'Rejected section scratch should close');
});

async function eventually(check, message) {
  const deadline = Date.now() + 3000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function assertClean(scratch) {
  await eventually(async () => (await readdir(scratch)).length === 0, 'scratch still contains an attempt');
}

async function checkMedia(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), String(payload.length));
  assert.equal(response.headers.get('x-content-sha256'), createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
}

test('returns the complete probed file with its length and digest, then cleans the attempt', async (t) => {
  const service = await startFixture(t);
  await checkMedia(await service.post());
  await assertClean(service.scratch);
});

test('rejects unauthorized callers, untrusted fields and malformed inputs before subprocess startup', async (t) => {
  const { post, marker, scratch } = await startFixture(t);
  const cases = [
    [{ headers: { authorization: '' }, body: '{' }, 401],
    [{ headers: { authorization: 'Bearer ' + randomBytes(32).toString('base64url') } }, 401],
    [{ method: 'GET' }, 405],
    [{ path: '/v1/elsewhere' }, 404],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-encoding': 'gzip' } }, 415],
    [{ body: 'x'.repeat(16384) }, 413],
    [{ body: '{' }, 400],
    [{ body: '{"videoId":"abcdefghijk","videoId":"abcdefghijk"}' }, 400],
    ...[null, [], {}, { videoId: 123 }, { videoId: videoId + ' ' }, { videoId: canonicalUrl },
      { videoId: '../outside' }, { videoId, destination: '/tmp/untrusted' }, { videoId, cookies: 'unused' }]
      .map((input) => [{ body: JSON.stringify(input) }, 400]),
  ];
  for (const [options, status] of cases) {
    const response = await post(options);
    assert.equal(response.status, status, JSON.stringify(options));
    await response.arrayBuffer();
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assertClean(scratch);
});

for (const mode of ['empty', 'partial-exit', 'bad-probe', 'no-audio', 'no-packets', 'no-duration', 'oversize']) {
  test('withholds media and cleans scratch for ' + mode, async (t) => {
    const { post, scratch } = await startFixture(t, mode, mode === 'oversize' ? { maxBytes: 64 } : {});
    const response = await post();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-content-sha256'), null);
    assert.doesNotMatch(await response.text(), /fixture-private-diagnostic/);
    await assertClean(scratch);
  });
}

async function waitForChild(marker) {
  let pid;
  await eventually(async () => {
    const content = await readFile(marker, 'utf8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return '';
    });
    if (!/^[1-9]\d*\n$/.test(content)) return false;
    pid = Number(content.trim());
    return true;
  }, 'fixture process did not reach the download step');
  return pid;
}

async function assertChildStopped(pid) {
  await eventually(() => {
    try { process.kill(pid, 0); }
    catch (err) { if (err.code === 'ESRCH') return true; throw err; }
    return false;
  }, 'fixture process outlived its canceled or timed-out request');
}

test('times out the native child, drains its attempt and accepts the next request', async (t) => {
  const { post, marker, scratch } = await startFixture(t, 'hang-once', { timeoutMs: 1000 });
  const pending = post();
  const pid = await waitForChild(marker);
  const response = await pending;
  assert.equal(response.status, 504);
  await response.arrayBuffer();
  await assertChildStopped(pid);
  await assertClean(scratch);
  await checkMedia(await post());
});

test('bounds concurrent work, then drains on caller disconnect before accepting another download', async (t) => {
  const { post, marker, scratch } = await startFixture(t, 'hang-once');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const first = post({ signal: controller.signal });
  const pid = await waitForChild(marker);
  const busy = await post();
  assert.equal(busy.status, 429);
  await busy.arrayBuffer();
  assert.equal((await readFile(marker, 'utf8')).trim(), String(pid));
  const aborted = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  await aborted;
  await assertChildStopped(pid);
  await assertClean(scratch);
  await checkMedia(await post());
});
