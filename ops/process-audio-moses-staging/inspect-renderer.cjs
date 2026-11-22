// Executed through stdin inside the original candidate container by the local operator.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function checkCloudReads() {
  const { applicationDefault } = require('firebase-admin/app');
  const { access_token } = await applicationDefault().getAccessToken().catch(() => {
    throw new Error('The installed staging ADC could not exchange credentials');
  });
  assert.ok(access_token);
  // Only request the control revision and metadata for a fresh, absent artifact.
  const read = (url) => fetch(url, { headers: { Authorization: 'Bearer ' + access_token },
    redirect: 'error', signal: AbortSignal.timeout(4000) });
  const control = await read('https://firestore.googleapis.com/v1/projects/urm-app-staging/databases/(default)/documents/_control/temporalRelease?mask.fieldPaths=revision');
  assert.equal(control.status, 200);
  const revision = (await control.json()).fields?.revision?.integerValue;
  assert.match(revision, /^[1-9][0-9]*$/);
  const path = encodeURIComponent('workflow-audio/moses-verification/' + crypto.randomUUID() + '/source.bin');
  const object = await read('https://storage.googleapis.com/storage/v1/b/urm-app-staging.firebasestorage.app/o/' + path + '?fields=generation');
  assert.equal(object.status, 404);
  await object.body?.cancel();
  return { firestoreRevision: revision, stagingObjectLookup: 'absent' };
}

async function inspect() {
  const [role, mode, commit] = process.argv.slice(2);
  const isolated = role === 'isolated-verification';
  const base = 'http://127.0.0.1:8080';
  const get = (path, method = 'GET') => fetch(base + path, {
    method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000),
  });
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.equal(os.tmpdir(), '/tmp');
  const scratch = fs.statSync('/tmp', { bigint: true });
  const disk = fs.statfsSync('/tmp', { bigint: true });
  assert.equal(scratch.uid, 1000n);
  assert.equal(scratch.mode & 0o777n, 0o700n);
  assert.ok(disk.bavail * disk.bsize >= 80n * 1024n ** 3n);
  fs.accessSync('/tmp', fs.constants.W_OK);
  const version = (command, arg) => execFileSync(command, [arg], { encoding: 'utf8', timeout: 4000 }).split('\n')[0];
  assert.equal(version('yt-dlp', '--version'), '2026.10.26');
  assert.match(version('deno', '--version'), /^deno 2\.9\.5\b/);
  const ffmpeg = version('ffmpeg', '-version');
  const ffprobe = version('ffprobe', '-version');
  assert.match(ffmpeg, /^ffmpeg version (?:n)?8\.1\b/);
  assert.match(ffprobe, /^ffprobe version (?:n)?8\.1\b/);
  fs.accessSync('/usr/bin/prlimit', fs.constants.X_OK);
  const response = await get('/healthz');
  assert.equal(response.status, 200);
  const h = await response.json();
  assert.equal(h.ok, true);
  assert.equal(h.service, 'process-audio');
  assert.equal(h.runtimeProfile, 'hetzner');
  assert.equal(h.temporalYouTubeRenderTarget, 'moses');
  assert.equal(h.temporalYouTubeRenderMode, mode);
  assert.equal(h.sentryEnvironment, 'staging');
  assert.equal(h.sentryRelease, 'process-audio-hetzner@staging-' + commit);
  assert.equal(h.sentryEnabled, !isolated);
  assert.equal(h.ytDlpJsRuntime, 'deno');
  assert.equal(h.ytDlpVersion, '2026.10.26');
  assert.equal(h.ytDlpUseCookiesForPublicVideos, 'false');
  assert.equal(h.localBrowserProfileDir, null);
  assert.equal(h.youtubeBrowserAuthHealth.profileDirConfigured, false);
  assert.equal(h.youtubeBrowserAuthHealth.refreshControlDir.configured, false);
  assert.equal(h.providerRelayEnabled, false);
  assert.equal(h.browserFallbackEnabled, false);
  assert.equal(h.finalBrowserFallbackConfigured, false);
  assert.equal(h.poTokenProviderConfigured, false);
  const id = crypto.randomUUID();
  const root = '/internal/temporal/youtube/acquisitions/ytacq-' + crypto.randomBytes(32).toString('hex');
  for (const method of ['GET', 'POST']) {
    for (const path of [root, root + '/render/authentication/' + id]) {
      assert.equal((await get(path, method)).status, 404);
    }
    if (mode === 'verify') assert.equal((await get(root + '/render/' + id, method)).status, 404);
  }
  const challenge = crypto.randomBytes(32).toString('hex');
  const probe = await get('/healthz?releaseChallenge=' + challenge);
  if (mode === 'verify') {
    assert.equal(probe.status, 404);
    assert.equal(h.temporalYouTubeRuntimeId, undefined);
  } else {
    assert.equal(probe.status, 200);
    const live = await probe.json();
    assert.equal(live.releaseChallenge, challenge);
    assert.equal(live.temporalYouTubeGuestOnly, true);
    assert.equal(live.temporalYouTubeRenderPinProtocol, 1);
    assert.match(live.temporalYouTubeRuntimeId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(live.temporalYouTubeRuntimeId, h.temporalYouTubeRuntimeId);
  }
  const cloudRead = isolated ? null : await checkCloudReads();
  return { cloudRead, uid: 1000, gid: 1000, device: scratch.dev.toString(), inode: scratch.ino.toString(),
    freeBytes: (disk.bsize * disk.bavail).toString(), ytDlp: h.ytDlpVersion, ffmpeg, ffprobe,
    runtimeId: h.temporalYouTubeRuntimeId ?? null, sentryRelease: h.sentryRelease };
}
inspect().then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
