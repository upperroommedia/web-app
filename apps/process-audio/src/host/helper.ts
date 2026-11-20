import { realpath, lstat } from 'node:fs/promises';
import { hostResourceRequest } from './resources';
import type { HostInput } from './input';
import type { HostOutcome } from './outcome';
const denied = () => new Error('HOST_ISOLATED_WORK_UNAVAILABLE');
export async function runFixedHostWork(
  raw: unknown,
  signal: AbortSignal = new AbortController().signal
): Promise<HostOutcome> {
  signal.throwIfAborted();
  if (
    process.platform !== 'linux' ||
    process.env.NODE_ENV !== 'production' ||
    process.env.URM_HOST_RESOURCE_PROTOCOL !== 'isolated-v1' ||
    [
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
    ].some((key) => process.env[key])
  )
    throw denied();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 65536)
    throw denied();
  const input = raw as HostInput;
  if (
    input.v !== 1 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.id) ||
    !['urm-app', 'urm-app-staging'].includes(input.projectId) ||
    input.projectId !== process.env.FIREBASE_PROJECT_ID ||
    !['legacy-full', 'canary'].includes(input.kind)
  )
    throw denied();
  const directory = `/workspace/host-resource/${input.id}`;
  if (process.env.TMPDIR !== directory || (await realpath(directory)) !== directory) throw denied();
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw denied();
  // Only this original freshly enrolled child can receive this native reply.
  // Self-reported cgroup IDs, PIDs, images and a parent's boolean are not proof.
  const proof = await hostResourceRequest(input.id, 'verify');
  if (proof.state !== 'enrolled' || proof.directory !== directory) throw denied();
  signal.throwIfAborted();
  const { Sentry } = await import('../instrument');
  void Sentry;
  const { getApps, deleteApp } = await import('firebase-admin/app');
  if (getApps().length) throw denied();
  let owned: ReturnType<typeof getApps>[number] | undefined;
  let firestore: import('firebase-admin/firestore').Firestore | undefined;
  let realtime: import('firebase-admin/database').Database | undefined;
  let failed = false;
  try {
    const { default: firebase } = await import('../firebaseAdmin');
    const created = getApps();
    if (created.length !== 1 || firebase.app() !== created[0]) throw denied();
    owned = created[0];
    if (owned.options.projectId !== input.projectId) throw denied();
    signal.throwIfAborted();
    const { captureHostOutcome } = await import('./outcome');
    const { CancelToken } = await import('../CancelToken');
    const token = new CancelToken();
    const abort = () => token.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    process.once('SIGTERM', abort);
    process.once('disconnect', abort);
    let value:
      | import('../processAudio').ProcessAudioResult
      | import('../youtubeReadiness').YouTubeMediaByteCanaryReport
      | undefined;
    let error: unknown;
    try {
      signal.throwIfAborted();
      realtime = firebase.database();
      if (input.kind === 'canary') {
        if (
          Object.keys(input).sort().join(',') !== 'ctx,id,kind,projectId,scope,v' ||
          !['guest', 'authenticated'].includes(input.scope)
        )
          throw denied();
        const api = await import('../processYouTubeUrl');
        value =
          input.scope === 'guest'
            ? await api.runGuestYouTubeMediaByteCanary('/usr/local/bin/yt-dlp', realtime, input.ctx)
            : await api.runAuthenticatedYouTubeMediaByteCanary('/usr/local/bin/yt-dlp', realtime, input.ctx);
      } else {
        const { validateAddIntroOutroData, getAudioSource } = await import('../utils');
        if (
          Object.keys(input).some(
            (key) =>
              !['v', 'id', 'projectId', 'kind', 'ctx', 'data', 'bucketName', 'originalSource', 'taskId'].includes(key)
          ) ||
          !validateAddIntroOutroData(input.data) ||
          input.ctx.sermonId !== input.data.id ||
          (input.taskId !== null && typeof input.taskId !== 'string')
        )
          throw denied();
        const { processAudio } = await import('../processAudio');
        const { pinOriginalLegacySourceBucket } = await import('../legacyMediaHttp');
        const { firestoreAdminSermonConverter } = await import('../firestoreAdminDataConverter');
        const { sermonStatusType, uploadStatus } = await import('../types');
        const bucket = firebase.storage().bucket();
        if (bucket.name !== input.bucketName) throw denied();
        firestore = firebase.firestore();
        value = await processAudio(
          '/usr/local/bin/yt-dlp',
          token,
          bucket,
          realtime,
          firestore,
          getAudioSource(input.data),
          firestore.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(input.data.id),
          {
            subsplash: uploadStatus.NOT_UPLOADED,
            soundCloud: uploadStatus.NOT_UPLOADED,
            audioStatus: sermonStatusType.PROCESSING,
          },
          input.data.startTime,
          input.data.duration,
          input.data.deleteOriginal,
          input.data.skipTranscode,
          input.data.introUrl,
          input.data.outroUrl,
          input.ctx,
          input.taskId,
          pinOriginalLegacySourceBucket(bucket, input.originalSource)
        );
      }
    } catch (caught) {
      error = caught;
      token.cancel();
    } finally {
      await token.waitForProcesses();
      signal.removeEventListener('abort', abort);
      process.removeListener('SIGTERM', abort);
      process.removeListener('disconnect', abort);
    }
    return captureHostOutcome(input.id, value, error, input.ctx);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Capture a partial initialization's exact new app object, never a name.
    owned ??= getApps().length === 1 ? getApps()[0] : undefined;
    let cleanupFailed = false;
    for (const close of [
      () => realtime?.goOffline(),
      () => firestore?.terminate(),
      () => (owned ? deleteApp(owned) : undefined),
    ]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wall = Date.now(),
        mono = performance.now();
      try {
        await Promise.race([
          Promise.resolve().then(close),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(denied()), 5000);
          }),
        ]);
        if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw denied();
      } catch {
        cleanupFailed = true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (cleanupFailed && !failed) throw denied();
  }
}
if (require.main === module) {
  const cancellation = new AbortController();
  let consumed = false,
    invalid = false;
  const inert = setTimeout(() => {
    process.exitCode = 1;
    process.disconnect?.();
  }, 10000);
  process.on('message', (message) => {
    if (consumed) {
      invalid = true;
      cancellation.abort(denied());
      return;
    }
    consumed = true;
    clearTimeout(inert);
    void runFixedHostWork(message, cancellation.signal)
      .then(async (result) => {
        if (invalid) throw denied();
        await new Promise<void>((resolve, reject) =>
          process.send!(result, (error) => (error ? reject(denied()) : resolve()))
        );
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.connected) process.disconnect();
      });
  });
}
