import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyMosesGuestAudio } from '../src/mosesGuestMedia';
import { CancelToken } from '../src/CancelToken';
import {
  downloadMosesGuestAudio,
  getMosesGuestSection,
  readMosesGuestAudioConfig,
  type MosesGuestAudioFallbackReason,
} from '../src/mosesGuestAudio';

const videoId = 'nWY8KnvYlLQ';
const secondId = 'a-b_C123456';
const origin = 'https://guest.internal.test:8443';
const token = Buffer.alloc(32, 0x99).toString('base64url');
const env = {
  MOSES_GUEST_AUDIO_ENABLED: 'true',
  MOSES_GUEST_AUDIO_ORIGIN: origin,
  MOSES_GUEST_AUDIO_TOKEN: token,
  MOSES_GUEST_AUDIO_VIDEO_IDS: videoId + ', ' + secondId,
};
const audio = Buffer.from([0, 19, 10, 255, 128, 0, 29, 5]);
const headerValues = {
  'content-type': 'application/octet-stream',
  'content-length': String(audio.length),
  'x-content-sha256': createHash('sha256').update(audio).digest('hex'),
};
function streamBytes(chunks: Buffer[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function audioResponse(headers = new Headers(headerValues), chunks = [audio.subarray(0, 3), audio.subarray(3)]) {
  return new Response(streamBytes(chunks), { status: 200, headers });
}

async function main() {
  assert.equal(readMosesGuestAudioConfig({}), null);
  for (const enabled of [undefined, '', '1', 'TRUE']) {
    assert.equal(readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_ENABLED: enabled }), null);
  }
  for (const value of [
    '',
    'http://guest.internal.test',
    'https://a:b@guest.internal.test',
    origin + '/api',
    origin + '/..',
    origin + '?x=1',
    origin + '#fragment',
    origin + '?',
    origin + '#',
    ' ' + origin,
    origin + '/\n',
  ])
    assert.equal(readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_ORIGIN: value }), null);
  for (const value of [undefined, '', token + '=', token.slice(1), token.slice(0, -1) + 'B', 'A'.repeat(42) + '+']) {
    assert.equal(readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_TOKEN: value }), null);
  }
  for (const value of ['', videoId + ',', videoId + ',*', 'https://youtu.be/' + videoId]) {
    assert.equal(readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_VIDEO_IDS: value }), null);
  }
  assert.equal(readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_VIDEO_IDS: undefined })?.videoIds, undefined);
  const config = readMosesGuestAudioConfig(env);
  assert.ok(config);
  assert.deepEqual([...config.videoIds!], [videoId, secondId]);

  const tempDir = await mkdtemp(join(tmpdir(), 'moses-client-test-'));
  try {
    const input = { config, tempDir, cancelToken: new CancelToken(), videoId };
    const successFetch: typeof fetch = async (url, init) => {
      assert.equal(String(url), origin + '/v1/youtube/guest-audio');
      assert.ok(init);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(String(init.body)), { videoId });
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        accept: 'application/octet-stream',
        'accept-encoding': 'identity',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      });
      return audioResponse();
    };
    const successful = await Promise.all([
      downloadMosesGuestAudio(input, { fetch: successFetch }),
      downloadMosesGuestAudio(input, { fetch: successFetch }),
    ]);
    const paths = new Set<string>();
    for (const result of successful) {
      assert.equal(result.status, 'downloaded');
      assert.equal(dirname(result.filePath), tempDir);
      assert.deepEqual(await readFile(result.filePath), audio);
      assert.equal((await stat(result.filePath)).mode & 0o777, 0o600);
      paths.add(result.filePath);
      await unlink(result.filePath);
    }
    assert.equal(paths.size, 2);

    const sectionConfig = readMosesGuestAudioConfig({ ...env, MOSES_GUEST_AUDIO_SECTION_ENABLED: 'true' });
    assert.ok(sectionConfig?.sectionEnabled);
    assert.equal(config.sectionEnabled, undefined);
    assert.deepEqual(getMosesGuestSection(86400, 3600), { startSeconds: 86400, durationSeconds: 3600 });
    assert.deepEqual(getMosesGuestSection(0, 0.000001), { startSeconds: 0, durationSeconds: 0.000001 });
    const section = { startSeconds: 18940.125, durationSeconds: 1279.5 };
    const sectionInput = { ...input, config: sectionConfig, section };
    const echoes = { ...headerValues, 'x-section-start-seconds': '18940.125', 'x-section-duration-seconds': '1279.5' };
    for (const invalid of [
      { startSeconds: -0, durationSeconds: 5 }, { startSeconds: -1, durationSeconds: 5 },
      { startSeconds: 86400.001, durationSeconds: 5 }, { startSeconds: 0, durationSeconds: 3600.001 },
      { startSeconds: 0, durationSeconds: 0 }, { startSeconds: 0, durationSeconds: 1e-7 },
      { startSeconds: Number.NaN, durationSeconds: 5 }, { startSeconds: 0, durationSeconds: Infinity },
    ]) {
      assert.equal(getMosesGuestSection(invalid.startSeconds, invalid.durationSeconds), undefined);
      assert.deepEqual(await downloadMosesGuestAudio({ ...sectionInput, section: invalid }, { fetch: async () => { throw new Error('Unexpected guest audio request'); } }),
        { status: 'fallback', reason: 'invalid_section' });
    }
    assert.deepEqual(await downloadMosesGuestAudio({ ...input, section }, { fetch: async () => { throw new Error('Unexpected guest audio request'); } }),
      { status: 'fallback', reason: 'invalid_section' });
    // Enabling sections leaves an explicitly ordinary v1 request on its existing route.
    const ordinary = await downloadMosesGuestAudio({ ...input, config: sectionConfig }, { fetch: successFetch });
    assert.equal(ordinary.status, 'downloaded');
    await unlink(ordinary.filePath);
    const served = await downloadMosesGuestAudio(sectionInput, { fetch: async (url, init) => {
      assert.equal(url, origin + '/v2/youtube/guest-audio-section');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity');
      assert.equal(init?.body, JSON.stringify({ videoId, ...section }));
      return audioResponse(new Headers(echoes));
    } });
    assert.equal(served.status, 'downloaded');
    assert.deepEqual(await readFile(served.filePath), audio);
    await unlink(served.filePath);
    for (const [name, value] of [
      ['x-section-start-seconds', null], ['x-section-duration-seconds', null],
      ['x-section-start-seconds', '18940.1250'], ['x-section-start-seconds', '0'],
      ['x-section-duration-seconds', '1.2795e3'], ['x-section-duration-seconds', '1279.5, 1279.5'],
    ] as const) {
      const amended = new Headers(echoes);
      if (value === null) amended.delete(name); else amended.set(name, value);
      let calls = 0;
      const rejected = await downloadMosesGuestAudio(sectionInput, { fetch: async url => {
        calls++;
        assert.equal(url, origin + '/v2/youtube/guest-audio-section');
        return audioResponse(amended);
      } });
      assert.deepEqual(rejected, { status: 'fallback', reason: 'invalid_response' });
      assert.equal(calls, 1);
      assert.deepEqual(await readdir(tempDir), []);
    }

    for (const [status, reason] of [
      [408, 'remote_error'], [499, 'remote_error'], [418, 'remote_error'], [504, 'remote_error'],
      [400, 'remote_refused'], [401, 'remote_refused'], [403, 'remote_refused'], [404, 'remote_refused'],
      [405, 'remote_refused'], [413, 'remote_refused'], [415, 'remote_refused'], [422, 'remote_refused'], [429, 'remote_busy'],
    ] as const) {
      assert.deepEqual(await downloadMosesGuestAudio(sectionInput, { fetch: async () => new Response(null, { status }) }),
        { status: 'fallback', reason });
    }

    const fakeProbe = join(tempDir, 'ffprobe-fixture');
    const probeOutput = join(tempDir, 'probe.json');
    await writeFile(fakeProbe, "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.argv.at(-1)));\n", { mode: 0o700 });
    for (const [measured, withinTolerance] of [[1277.5, true], [1281.5, true], [1277.49, false], [1281.51, false], [25782, false]] as const) {
      await writeFile(probeOutput, JSON.stringify({ streams: [{ codec_type: 'audio', nb_read_packets: '10' }], format: { duration: String(measured) } }));
      assert.equal(await verifyMosesGuestAudio(probeOutput, () => fakeProbe, section.durationSeconds), withinTolerance);
    }
    assert.equal(await verifyMosesGuestAudio(probeOutput, () => fakeProbe), true);
    await unlink(fakeProbe);
    await unlink(probeOutput);

    let ineligibleCalls = 0;
    const neverFetch: typeof fetch = async () => {
      ++ineligibleCalls;
      return audioResponse();
    };
    for (const badId of ['https://youtu.be/' + videoId, videoId + '/..', 'B'.repeat(11)]) {
      assert.deepEqual(await downloadMosesGuestAudio({ ...input, videoId: badId }, { fetch: neverFetch }), {
        status: 'fallback',
        reason: 'ineligible_video',
      });
    }
    const cancelled = new CancelToken();
    cancelled.cancel();
    assert.deepEqual(await downloadMosesGuestAudio({ ...input, cancelToken: cancelled }, { fetch: neverFetch }), {
      status: 'cancelled',
    });
    assert.equal(ineligibleCalls, 0);

    async function expectFallback(mock: typeof fetch, reason: MosesGuestAudioFallbackReason) {
      let calls = 0;
      let signal: AbortSignal | null | undefined;
      const result = await downloadMosesGuestAudio(input, {
        fetch: (url, init) => {
          ++calls;
          signal = init?.signal;
          return mock(url, init);
        },
      });
      assert.deepEqual(result, { status: 'fallback', reason });
      assert.equal(calls, 1);
      assert.equal(signal?.aborted, true);
      assert.deepEqual(await readdir(tempDir), []);
    }
    for (const [status, reason] of [
      [302, 'invalid_response'],
      [206, 'invalid_response'],
      [401, 'remote_refused'],
      [429, 'remote_busy'],
      [503, 'remote_error'],
    ] as const) {
      await expectFallback(async () => new Response('private error body', { status }), reason);
    }
    for (const [header, value] of [
      ['content-type', null],
      ['content-type', 'text/plain'],
      ['content-encoding', 'gzip'],
      ['content-encoding', 'identity'],
      ['content-range', 'bytes 0-7/8'],
      ['content-length', null],
      ['content-length', '0'],
      ['content-length', '08'],
      ['content-length', '209715201'],
      ['content-length', '8, 8'],
      ['x-content-sha256', null],
      ['x-content-sha256', headerValues['x-content-sha256'].toUpperCase()],
    ] as const) {
      const headers = new Headers(headerValues);
      if (value === null) headers.delete(header);
      else headers.set(header, value);
      await expectFallback(async () => audioResponse(headers), 'invalid_response');
    }
    await expectFallback(async () => new Response(null, { headers: headerValues }), 'invalid_response');
    await expectFallback(
      async () => audioResponse(new Headers(headerValues), [audio.subarray(1)]),
      'integrity_mismatch'
    );
    await expectFallback(async () => audioResponse(new Headers(headerValues), [audio, audio]), 'integrity_mismatch');
    await expectFallback(
      async () => audioResponse(new Headers(headerValues), [Buffer.alloc(audio.length)]),
      'integrity_mismatch'
    );
    await expectFallback(async () => {
      throw new Error('private upstream error');
    }, 'transfer_interrupted');
    await expectFallback(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private body failure'));
            },
          }),
          { headers: headerValues }
        ),
      'transfer_interrupted'
    );

    // Both timeout and task cancellation apply while waiting for response headers.
    for (const stop of ['timeout', 'cancellation'] as const) {
      const cancelToken = new CancelToken();
      const result = await downloadMosesGuestAudio(
        { ...input, cancelToken },
        {
          fetch: (_, init) =>
            new Promise<Response>((_, reject) => {
              assert.ok(init?.signal);
              init.signal.addEventListener('abort', () => reject(new Error('private transport failure')), {
                once: true,
              });
              if (stop === 'cancellation') cancelToken.cancel();
            }),
          timeoutMs: stop === 'timeout' ? 20 : 3_000,
        }
      );
      assert.deepEqual(
        result,
        stop === 'timeout' ? { status: 'fallback', reason: 'timeout' } : { status: 'cancelled' }
      );
      assert.deepEqual(await readdir(tempDir), []);
    }

    // A stalled response must reach EOF before publication, even after every declared byte arrives.
    for (const stop of ['timeout', 'cancellation'] as const) {
      const cancelToken = new CancelToken();
      let bodyCancelled = false;
      const result = downloadMosesGuestAudio(
        { ...input, cancelToken },
        {
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(audio);
                },
                cancel() {
                  bodyCancelled = true;
                },
              }),
              { headers: headerValues }
            ),
          timeoutMs: stop === 'timeout' ? 250 : 3_000,
        }
      );
      if (stop === 'cancellation') {
        try {
          let received = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const [name] = await readdir(tempDir);
            if (name?.endsWith('.part') && (await stat(join(tempDir, name))).size === audio.length) {
              received = true;
              break;
            }
            await delay(10);
          }
          assert.ok(received);
        } finally {
          cancelToken.cancel();
        }
      }
      assert.deepEqual(
        await result,
        stop === 'timeout' ? { status: 'fallback', reason: 'timeout' } : { status: 'cancelled' }
      );
      assert.equal(bodyCancelled, true);
      assert.deepEqual(await readdir(tempDir), []);
    }

    const failedWrite = await downloadMosesGuestAudio(
      { ...input, tempDir: join(tempDir, 'absent') },
      { fetch: successFetch }
    );
    assert.deepEqual(failedWrite, { status: 'fallback', reason: 'local_io' });
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('Moses guest audio client checks passed'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
