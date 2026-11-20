import { lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { CancelToken } from '../CancelToken';
import type { MediaJobRef } from './types';

const ROOT = '/workspace/yt-acquisition-scratch';
const denied = () => new Error('YOUTUBE_HELPER_UNCONFIRMED');
/** This entrypoint stays inert: no Firebase, provider, browser, or private input
 * initialization until the original parent has claimed this exact native child. */
async function execute(message: unknown, cancellation: CancelToken): Promise<void> {
  if (!message || typeof message !== 'object' || Array.isArray(message) || process.platform !== 'linux') throw denied();
  if (
    process.env.NODE_ENV !== 'production' ||
    [
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
    ].some((key) => Boolean(process.env[key]))
  )
    throw denied();
  if (Object.hasOwn(message, 'renderCallerEmail')) {
    await executeRender(message, cancellation);
    return;
  }
  const input = message as { operationId: string; ref: MediaJobRef; directory: string; episodeId: string };
  if (
    Object.keys(input).sort().join(',') !== 'directory,episodeId,operationId,ref' ||
    typeof input.directory !== 'string'
  )
    throw denied();
  const { youtubeAcquisitionId } = await import('./hetzner-acquisition');
  const { acquisitionHostBuildId } = await import('./hetzner-acquisition-driver');
  const ref = Object.freeze({ ...input.ref });
  if (
    youtubeAcquisitionId(ref) !== input.operationId ||
    dirname(input.directory) !== ROOT ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.episodeId) ||
    basename(input.directory) !== input.episodeId ||
    process.env.TMPDIR !== input.directory
  )
    throw denied();
  const [path, directory, filesystem] = await Promise.all([
    realpath(input.directory),
    lstat(input.directory),
    statfs(input.directory),
  ]);
  if (
    path !== input.directory ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700 ||
    filesystem.type !== 0x01021994 ||
    filesystem.blocks <= 0 ||
    filesystem.blocks * filesystem.bsize > 256 * 1024 ** 2
  )
    throw denied();
  cancellation.signal.throwIfAborted();
  const { hostResourceRequest } = await import('../host/resources');
  const proof = await hostResourceRequest(input.episodeId, 'verify');
  if (proof.state !== 'enrolled' || proof.directory !== input.directory || !proof.receiptHash) throw denied();
  cancellation.signal.throwIfAborted();
  const { inspectNativeYouTubeProcess } = await import('./hetzner-acquisition-identity');
  const owner = await inspectNativeYouTubeProcess(process.pid, acquisitionHostBuildId());
  const { withOwnedAcquisitionFirebase } = await import('./hetzner-acquisition-firebase');
  await withOwnedAcquisitionFirebase(async (firebaseAdmin) => {
    if (
      firebaseAdmin.app().options.projectId !== ref.projectId ||
      firebaseAdmin.storage().bucket().name !== 'urm-app-staging.firebasestorage.app'
    )
      throw denied();
    const db = firebaseAdmin.firestore(),
      auth = firebaseAdmin.auth();
    const { createCanonicalYouTubeHostStore } = await import('./hetzner-acquisition-authorization');
    const store = createCanonicalYouTubeHostStore({
      firestore: db,
      auth,
      owner,
      signal: cancellation.signal,
      episodeId: input.episodeId,
      nativeEnrollment: proof,
    });
    await store.assertCurrent(ref);
    const { readEligibleYouTubeAcquisition } = await import('./hetzner-acquisition-policy');
    const eligible = await db.runTransaction((transaction) =>
      readEligibleYouTubeAcquisition({ firestore: db, auth, transaction, ref })
    );
    if (eligible.kind !== 'ready') throw denied();
    const { createNativeYouTubeAcquisitionSink } = await import('./hetzner-acquisition-sink');
    const { acquireYouTubeToStream } = await import('../processYouTubeUrl');
    const { drainNativeYouTubeSession } = await import('./hetzner-acquisition-producer');
    let checking = false;
    let pendingGuard: Promise<void> | undefined;
    const watchdog = setInterval(() => {
      if (checking) return;
      checking = true;
      pendingGuard = store
        .assertCurrent(ref)
        .catch(() => cancellation.cancel())
        .finally(() => {
          checking = false;
        });
    }, 500);
    watchdog.unref();
    try {
      try {
        const artifact = await acquireYouTubeToStream(
          '/usr/local/bin/yt-dlp',
          eligible.payload.youtubeUrl,
          join(input.directory, 'source'),
          cancellation,
          () => undefined,
          firebaseAdmin.database(),
          undefined,
          createNativeYouTubeAcquisitionSink({ ref, store })
        );
        cancellation.signal.throwIfAborted();
        await store.settle(ref, { kind: 'source', artifact }, async () => {
          if (await drainNativeYouTubeSession(input.directory)) throw denied();
        });
      } catch (error) {
        cancellation.signal.throwIfAborted();
        const evidence = (error as import('../processYouTubeUrl').YouTubeAcquisitionError)?.youtubeAcquisitionEvidence;
        const { getYouTubeFailureDisposition } = await import('@upperroom/contracts/processAudioQueue');
        if (!evidence) throw error;
        const disposition = getYouTubeFailureDisposition(evidence);
        if (!['task_retry', 'post_live_retry'].includes(disposition.action)) throw error;
        // Only known provider failure before ANY upload is eligible here. The
        // store independently fences uncertain uploads. Auth recovery remains
        // separate until a successful same-host canary protocol exists.
        await store.settle(
          ref,
          { kind: disposition.action === 'post_live_retry' ? 'waiting_archive' : 'retryable' },
          async () => {
            await cancellation.waitForProcesses();
            if (await drainNativeYouTubeSession(input.directory)) throw denied();
          },
          evidence
        );
      }
    } finally {
      clearInterval(watchdog);
      cancellation.cancel();
      await pendingGuard?.catch(() => undefined);
      await cancellation.waitForProcesses();
      // Failure stays fenced; never invent a terminal business result from a signal.
      if (await drainNativeYouTubeSession(input.directory)) throw denied();
    }
  });
}
async function executeRender(message: object, cancellation: CancelToken): Promise<void> {
  const input = message as {
    operationId: string;
    ref: MediaJobRef;
    directory: string;
    episodeId: string;
    renderCallerEmail: string;
    authenticationId?: string;
  };
  if (
    Object.keys(input).sort().join(',') !==
      (input.authenticationId === undefined
        ? 'directory,episodeId,operationId,ref,renderCallerEmail'
        : 'authenticationId,directory,episodeId,operationId,ref,renderCallerEmail') ||
    (input.authenticationId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.authenticationId)) ||
    process.env.PROCESS_AUDIO_RUNTIME_PROFILE !== 'hetzner' ||
    typeof input.directory !== 'string' ||
    !input.directory.startsWith('/') ||
    !/^youtube-render-[A-Za-z0-9]+$/.test(basename(input.directory)) ||
    input.directory !== process.env.TMPDIR ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.episodeId) ||
    !/^tw-m-[a-f0-9]{20}@urm-app-staging\.iam\.gserviceaccount\.com$/.test(input.renderCallerEmail)
  )
    throw denied();
  const [path, native] = await Promise.all([realpath(input.directory), lstat(input.directory)]);
  if (
    path !== input.directory ||
    !native.isDirectory() ||
    native.uid !== process.getuid?.() ||
    (native.mode & 0o777) !== 0o700
  )
    throw denied();
  const { youtubeAcquisitionId } = await import('./hetzner-acquisition');
  const ref = Object.freeze({ ...input.ref });
  if (youtubeAcquisitionId(ref) !== input.operationId) throw denied();
  cancellation.signal.throwIfAborted();
  if (input.authenticationId === undefined) {
    const { assertNativeYouTubeRenderFileLimit } = await import('./hetzner-render-limits');
    await assertNativeYouTubeRenderFileLimit();
  }
  cancellation.signal.throwIfAborted();
  const { acquisitionHostBuildId } = await import('./hetzner-acquisition-driver');
  const { withOwnedAcquisitionFirebase } = await import('./hetzner-acquisition-firebase');
  await withOwnedAcquisitionFirebase(async (sdk) => {
    if (sdk.app().options.projectId !== ref.projectId) throw denied();
    if (input.authenticationId !== undefined) {
      const { recordRenderAuthenticationProbe } = await import('./hetzner-render-authentication');
      const { readEligibleYouTubeAcquisition } = await import('./hetzner-acquisition-policy');
      const { refreshRenderAuthenticationBrowser, runAuthenticatedYouTubeMediaByteCanary, withYouTubeCancellation } =
        await import('../processYouTubeUrl');
      const { createContext } = await import('../context');
      const { drainNativeYouTubeSession } = await import('./hetzner-acquisition-producer');
      const firestore = sdk.firestore(),
        auth = sdk.auth();
      try {
        await recordRenderAuthenticationProbe({
          firestore,
          ref,
          id: input.authenticationId,
          buildId: acquisitionHostBuildId(),
          verifiedCallerEmail: input.renderCallerEmail,
          signal: cancellation.signal,
          directory: input.directory,
          assertCurrent: async (transaction, bound) => {
            const result = await readEligibleYouTubeAcquisition({ firestore, auth, transaction, ref: bound });
            if (result.kind !== 'ready') throw denied();
          },
          refresh: (watcherRequestId) =>
            withYouTubeCancellation(cancellation, () =>
              refreshRenderAuthenticationBrowser(
                createContext(ref.sermonId, 'temporal-youtube-authentication'),
                watcherRequestId
              )
            ),
          probe: () =>
            withYouTubeCancellation(cancellation, () =>
              runAuthenticatedYouTubeMediaByteCanary(
                'yt-dlp',
                sdk.database(),
                createContext(ref.sermonId, 'temporal-youtube-authentication'),
                true
              )
            ),
        });
      } finally {
        await cancellation.waitForProcesses();
        if (await drainNativeYouTubeSession(input.directory)) throw denied();
      }
      return;
    }
    const { runOwnedYouTubeRender } = await import('./hetzner-render-work');
    await runOwnedYouTubeRender({
      firestore: sdk.firestore(),
      auth: sdk.auth(),
      bucket: sdk.storage().bucket(),
      realtimeDB: sdk.database(),
      ref,
      episodeId: input.episodeId,
      directory: input.directory,
      verifiedCallerEmail: input.renderCallerEmail,
      buildId: acquisitionHostBuildId(),
      ytdlpPath: 'yt-dlp',
      cancellation,
    });
  });
}

if (require.main === module) {
  const cancellation = new CancelToken();
  let received = false,
    invalid = false;
  const inertDeadline = setTimeout(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }, 10000);
  const abort = () => {
    invalid = true;
    cancellation.cancel();
  };
  process.on('SIGTERM', abort);
  process.on('disconnect', abort);
  process.on('message', (message) => {
    if (received) {
      abort();
      process.exitCode = 1;
      return;
    }
    received = true;
    clearTimeout(inertDeadline);
    void execute(message, cancellation)
      .then(
        () => {
          process.exitCode = invalid ? 1 : 0;
        },
        () => {
          process.exitCode = 1;
        }
      )
      .finally(() => {
        process.removeListener('SIGTERM', abort);
        process.removeListener('disconnect', abort);
        if (process.connected) process.disconnect();
      });
  });
}
