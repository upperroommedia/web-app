import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { Bucket } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import type { Database } from 'firebase-admin/database';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  computeProcessAudioRequestVersion,
  getYouTubeFailureDisposition,
} from '@upperroom/contracts/processAudioQueue';
import { CancelToken } from '../CancelToken';
import type { YouTubeAcquisitionError } from '../processYouTubeUrl';
import { createContext } from '../context';
import { getFFmpegPath, getFFprobePath, validateAddIntroOutroData } from '../utils';
import { downloadMediaStream, runMediaCommand, uploadMediaStream } from './native';
import type { MediaActivities, MediaJobProjection, MediaJobRef, MediaOutcome, MediaStage } from './types';
import { checkMediaWorkspace, mediaResources, reserveMediaWorkspace } from './resources';
import { createMediaAuthenticationProbe } from './authentication';
import {
  MEDIA_ARTIFACTS,
  mediaArtifactId,
  prepareMediaReference,
  prepareMediaReferenceRelease,
  releaseMediaJobArtifacts,
  writeMediaUploadIntent,
} from '@upperroom/orchestration/media-artifacts';

type Artifact = { path: string; generation: string; duration: number };
type PrivateRequest = {
  ref: MediaJobRef;
  payload: AddIntroOutroInputType;
  sources: Record<string, { path: string; generation: string }>;
  artifacts?: { source?: Artifact; processed?: Artifact; final?: Artifact };
};
export interface MediaActivityDependencies {
  projectId: string;
  assertAuthorized: (ref: MediaJobRef) => Promise<void>;
  firestore: Firestore;
  database: Database;
  bucket: Bucket;
  ytdlpPath: string;
  projectJob: (ref: MediaJobRef, projection: MediaJobProjection) => Promise<void>;
  /** Must perform a real authenticated media-byte canary, not merely inspect cookies. */
  checkAuthenticatedMedia?: (ref: MediaJobRef) => Promise<{ ready: boolean; generation: string | null }>;
}

const matches = (left: MediaJobRef | undefined, right: MediaJobRef) =>
  left?.jobId === right.jobId &&
  left.projectId === right.projectId &&
  left.revision === right.revision &&
  left.requestVersion === right.requestVersion;

export function storagePathFromMediaUrl(value: string, bucket: string): string {
  if (!value.includes('://')) return value;
  const url = new URL(value);
  if (url.protocol === 'gs:' && url.hostname === bucket) return decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'https:')
    throw ApplicationFailure.nonRetryable('Invalid media storage reference', 'INVALID_MEDIA_SOURCE');
  if (url.hostname === 'firebasestorage.googleapis.com') {
    const match = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
    if (match && decodeURIComponent(match[1]) === bucket) return decodeURIComponent(match[2]);
  }
  if (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith(`/${bucket}/`))
    return decodeURIComponent(url.pathname.slice(bucket.length + 2));
  throw ApplicationFailure.nonRetryable('Media must belong to the application storage bucket', 'INVALID_MEDIA_SOURCE');
}

/** Private request documents are never serialized into Temporal event history. */
export function createMediaActivities(dependencies: MediaActivityDependencies): MediaActivities {
  const { firestore: db, database: realtime, bucket } = dependencies;
  const authenticationProbe = dependencies.checkAuthenticatedMedia ?? createMediaAuthenticationProbe(dependencies);
  const requestDoc = (ref: MediaJobRef) => db.collection('temporalMediaRequests').doc(ref.jobId);
  const stateDoc = (ref: MediaJobRef) => db.collection('temporalMediaState').doc(ref.sermonId);
  const sermonDoc = (ref: MediaJobRef) => db.collection('sermons').doc(ref.sermonId);
  const validRef = (ref: MediaJobRef) => {
    if (
      ref.projectId !== dependencies.projectId ||
      !/^[A-Za-z0-9_-]+$/.test(ref.jobId) ||
      !/^[A-Za-z0-9_-]+$/.test(ref.sermonId) ||
      !/^[a-f0-9]{16}$/.test(ref.requestVersion) ||
      !Number.isSafeInteger(ref.revision) ||
      ref.revision < 1
    )
      throw ApplicationFailure.nonRetryable('Invalid media job reference', 'INVALID_MEDIA_REFERENCE');
  };
  const load = async (ref: MediaJobRef): Promise<PrivateRequest> => {
    validRef(ref);
    const snapshot = await requestDoc(ref).get();
    const request = snapshot.data() as PrivateRequest | undefined;
    if (
      !request ||
      !matches(request.ref, ref) ||
      !validateAddIntroOutroData(request.payload) ||
      computeProcessAudioRequestVersion(request.payload) !== ref.requestVersion
    )
      throw ApplicationFailure.nonRetryable('Media request is missing or inconsistent', 'INVALID_MEDIA_REQUEST');
    return request;
  };
  const eligibility = async (ref: MediaJobRef): Promise<MediaOutcome> => {
    validRef(ref);
    const [sermon, state, job] = await Promise.all([
      sermonDoc(ref).get(),
      stateDoc(ref).get(),
      db.collection('durableJobs').doc(ref.jobId).get(),
    ]);
    if (!sermon.exists) return { kind: 'deleted' };
    if (state.data()?.owner !== 'temporal' || !matches(state.data()?.ref, ref)) return { kind: 'superseded' };
    if (job.get('state') === 'succeeded') return { kind: 'completed' };
    if (job.get('state') === 'failed')
      throw ApplicationFailure.nonRetryable('Media job already failed', 'MEDIA_JOB_TERMINAL');
    if (job.get('state') === 'superseded') return { kind: 'superseded' };
    if (state.get('cancellationJobId') === ref.jobId || ['cancel_requested', 'cancelled'].includes(job.get('state')))
      return { kind: 'cancelled' };
    await dependencies.assertAuthorized(ref);
    return { kind: 'ready' };
  };
  const project = async (ref: MediaJobRef, stage: MediaStage, progress: number) => {
    const projected = await db.runTransaction(async (transaction) => {
      const [sermon, state, job] = await Promise.all([
        transaction.get(sermonDoc(ref)),
        transaction.get(stateDoc(ref)),
        transaction.get(db.collection('durableJobs').doc(ref.jobId)),
      ]);
      if (
        !sermon.exists ||
        !matches(state.data()?.ref, ref) ||
        ['cancel_requested', 'cancelled'].includes(job.get('state'))
      )
        return false;
      transaction.update(sermon.ref, { 'status.audioStatus': 'PROCESSING', 'status.message': stage });
      return true;
    });
    if (!projected) return;
    await dependencies.projectJob(ref, { state: 'running', stage });
    await realtime.ref(`addIntroOutro/${ref.sermonId}`).transaction((current) =>
      current?.revision > ref.revision
        ? undefined
        : {
            percent: progress,
            overallPercent: progress,
            stagePercent: progress,
            stage: stage === 'merging' ? 'finalizing' : stage === 'preparing' ? 'processing' : stage,
            stageLabel: stage,
            updatedAt: new Date().toISOString(),
            revision: ref.revision,
          }
    );
  };
  const withNativeActivity = async <T>(
    ref: MediaJobRef,
    stage: MediaStage,
    run: (directory: string, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const context = Context.current();
    const budgetController = new AbortController();
    const signal = AbortSignal.any([context.cancellationSignal, budgetController.signal]);
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'temporal-media-'));
    let release: (() => void) | undefined;
    try {
      release = await reserveMediaWorkspace(directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    let checking = false;
    const budgetTimer = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      void checkMediaWorkspace(directory)
        .catch((error) => {
          budgetController.abort(error);
        })
        .finally(() => {
          checking = false;
        });
    }, 500);
    budgetTimer.unref();
    const timer = setInterval(() => context.heartbeat({ jobId: ref.jobId, stage }), 10_000);
    timer.unref();
    context.heartbeat({ jobId: ref.jobId, stage });
    try {
      const result = await run(directory, signal);
      await checkMediaWorkspace(directory);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      // Acquisition classification needs its structured evidence before sanitizing the error.
      if ((error as YouTubeAcquisitionError)?.youtubeAcquisitionEvidence || error instanceof ApplicationFailure)
        throw error;
      throw ApplicationFailure.create({ message: `Audio ${stage} failed`, type: 'MEDIA_STAGE_FAILED' });
    } finally {
      clearInterval(timer);
      clearInterval(budgetTimer);
      try {
        await rm(directory, { recursive: true, force: true });
      } finally {
        release?.();
      }
    }
  };
  const download = async (path: string, destination: string, signal: AbortSignal, generation?: string) => {
    const file = bucket.file(path, generation ? { generation } : undefined);
    const [metadata] = await file.getMetadata();
    if (
      !Number.isFinite(Number(metadata.size)) ||
      Number(metadata.size) <= 0 ||
      Number(metadata.size) > mediaResources.sourceBytes
    )
      throw ApplicationFailure.nonRetryable('Audio source exceeds supported byte budget', 'MEDIA_BYTE_BUDGET');
    await downloadMediaStream(file.createReadStream(), destination, signal, mediaResources.sourceBytes);
  };
  const measure = async (path: string, signal: AbortSignal): Promise<number> => {
    const output = await runMediaCommand(
      getFFprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-of', 'json', path],
      signal
    );
    const duration = Number(JSON.parse(output)?.format?.duration);
    const bitRate = Number(JSON.parse(output)?.format?.bit_rate ?? 0);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 86400 ||
      !Number.isFinite(bitRate) ||
      bitRate < 0 ||
      bitRate > 100_000_000
    )
      throw ApplicationFailure.nonRetryable('Audio duration is invalid', 'INVALID_MEDIA_ARTIFACT');
    return duration;
  };
  const sourceFormat = async (path: string, signal: AbortSignal) => {
    const output = await runMediaCommand(
      getFFprobePath(),
      ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'json', path],
      signal
    );
    const format = String(JSON.parse(output)?.format?.format_name ?? '');
    if (format.includes('mp3')) return { suffix: 'mp3', contentType: 'audio/mpeg' };
    if (format.includes('mov') || format.includes('mp4')) return { suffix: 'm4a', contentType: 'audio/mp4' };
    if (format.includes('webm') || format.includes('matroska')) return { suffix: 'webm', contentType: 'audio/webm' };
    if (format.includes('wav')) return { suffix: 'wav', contentType: 'audio/wav' };
    if (format.includes('ogg')) return { suffix: 'ogg', contentType: 'audio/ogg' };
    if (format.includes('flac')) return { suffix: 'flac', contentType: 'audio/flac' };
    return { suffix: 'bin', contentType: 'application/octet-stream' };
  };
  const audioFormatSignature = async (path: string, signal: AbortSignal) => {
    const output = await runMediaCommand(
      getFFprobePath(),
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name,sample_rate,channels',
        '-of',
        'json',
        path,
      ],
      signal
    );
    const stream = JSON.parse(output)?.streams?.[0];
    if (!stream?.codec_name || !stream.sample_rate || !stream.channels)
      throw ApplicationFailure.nonRetryable('Audio stream format is invalid', 'INVALID_MEDIA_ARTIFACT');
    return JSON.stringify([stream.codec_name, stream.sample_rate, stream.channels]);
  };
  const saveArtifact = async (
    ref: MediaJobRef,
    stage: 'source' | 'processed' | 'final',
    path: string,
    duration: number,
    signal: AbortSignal
  ): Promise<void> => {
    const format = stage === 'source' ? await sourceFormat(path, signal) : { suffix: 'mp3', contentType: 'audio/mpeg' };
    const file = bucket.file(
      `workflow-audio/${ref.sermonId}/${ref.requestVersion}/${stage}-${randomUUID()}.${format.suffix}`
    );
    const artifactId = mediaArtifactId(ref.projectId, file.name);
    await db.runTransaction(async (transaction) => {
      const request = await transaction.get(requestDoc(ref));
      if (!matches(request.get('ref'), ref)) throw new Error('Media request changed before upload.');
      writeMediaUploadIntent(transaction, db, {
        projectId: ref.projectId,
        sermonId: ref.sermonId,
        jobId: ref.jobId,
        path: file.name,
        createdAt: Date.now(),
      });
    });
    await uploadMediaStream(
      path,
      file.createWriteStream({
        resumable: false,
        contentType: format.contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          metadata: {
            jobId: ref.jobId,
            requestVersion: ref.requestVersion,
            firebaseStorageDownloadTokens: randomUUID(),
          },
        },
      }),
      signal
    );
    const [metadata] = await file.getMetadata();
    const artifact: Artifact = { path: file.name, generation: String(metadata.generation), duration };
    let keep: boolean | undefined;
    try {
      keep = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(requestDoc(ref));
        const current = snapshot.data() as PrivateRequest | undefined;
        transaction.update(db.collection(MEDIA_ARTIFACTS).doc(artifactId), {
          generation: artifact.generation,
          status: 'retained',
        });
        if (!matches(current?.ref, ref)) return false;
        if (current?.artifacts?.[stage]) return false;
        transaction.update(snapshot.ref, { [`artifacts.${stage}`]: artifact });
        return true;
      });
    } finally {
      // An ambiguous database commit must never delete an artifact its receipt may reference.
      if (keep === false) {
        await file.delete({ ifGenerationMatch: metadata.generation, ignoreNotFound: true });
        await db.collection(MEDIA_ARTIFACTS).doc(artifactId).update({ status: 'deleted', deletedAt: Date.now() });
      }
    }
  };
  const verifyArtifact = async (artifact: Artifact) => {
    const [metadata] = await bucket.file(artifact.path).getMetadata();
    if (String(metadata.generation) !== artifact.generation || Number(metadata.size) <= 0)
      throw ApplicationFailure.nonRetryable(
        'Persisted audio artifact was changed or removed',
        'INVALID_MEDIA_ARTIFACT'
      );
  };

  return {
    prepareMedia: async (ref) => {
      const eligible = await eligibility(ref);
      if (eligible.kind !== 'ready') return eligible;
      const { payload } = await load(ref);
      if (payload.skipTranscode && 'youtubeUrl' in payload)
        throw ApplicationFailure.nonRetryable('YouTube cannot skip transcoding', 'INVALID_MEDIA_REQUEST');
      await db.runTransaction(async (transaction) => {
        const state = await transaction.get(stateDoc(ref));
        if (matches(state.get('ref'), ref)) transaction.update(state.ref, { runningRef: ref });
      });
      await project(ref, 'preparing', 0);
      return { kind: 'ready' };
    },
    acquireMedia: async (ref) => {
      const eligible = await eligibility(ref);
      if (eligible.kind !== 'ready') return eligible;
      const request = await load(ref);
      if (request.artifacts?.processed) {
        await verifyArtifact(request.artifacts.processed);
        return { kind: 'ready' };
      }
      const { payload } = request;
      try {
        return await withNativeActivity(ref, 'downloading', async (directory, signal) => {
          let input = join(directory, 'source');
          await project(ref, 'downloading', 5);
          if (request.artifacts?.source) {
            await download(request.artifacts.source.path, input, signal, request.artifacts.source.generation);
          } else if ('youtubeUrl' in payload) {
            const { downloadYouTubeAudioToFile } = await import('../processYouTubeUrl');
            const cancellation = new CancelToken();
            const abort = () => cancellation.cancel();
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) cancellation.cancel();
            try {
              input = await downloadYouTubeAudioToFile(
                dependencies.ytdlpPath,
                payload.youtubeUrl,
                input,
                cancellation,
                (percent) => Context.current().heartbeat({ jobId: ref.jobId, stage: 'downloading', percent }),
                realtime,
                createContext(ref.sermonId, 'temporal-media-acquire')
              );
            } finally {
              signal.removeEventListener('abort', abort);
              // The legacy downloader may reject before close. Native processes must be drained first.
              if (signal.aborted) cancellation.cancel();
              await cancellation.waitForProcesses();
            }
          } else {
            const source = request.sources.storage;
            if (!source)
              throw ApplicationFailure.nonRetryable('Pinned media source is missing', 'INVALID_MEDIA_SOURCE');
            await download(source.path, input, signal, source.generation);
          }
          signal.throwIfAborted();
          const sourceDuration = request.artifacts?.source?.duration ?? (await measure(input, signal));
          if (payload.startTime >= sourceDuration || payload.startTime + payload.duration > sourceDuration + 1)
            throw ApplicationFailure.nonRetryable('Requested trim exceeds available audio', 'INVALID_MEDIA_RANGE');
          if (!request.artifacts?.source) {
            const duration = sourceDuration;
            const pinned = request.sources.storage;
            if (pinned?.path.startsWith(`workflow-audio/${ref.sermonId}/`)) {
              // Re-trimming reuses its immutable original acquisition instead of copying long media again.
              await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(requestDoc(ref));
                const attach = await prepareMediaReference(transaction, db, {
                  artifactId: mediaArtifactId(ref.projectId, pinned.path),
                  projectId: ref.projectId,
                  type: 'media_job',
                  id: ref.jobId,
                  createdAt: Date.now(),
                });
                if (!snapshot.get('artifacts.source'))
                  transaction.update(snapshot.ref, {
                    'artifacts.source': { ...pinned, duration },
                  });
                attach();
              });
            } else await saveArtifact(ref, 'source', input, duration, signal);
          }
          await project(ref, 'transcoding', 50);
          const output = join(directory, 'processed.mp3');
          const args = [
            '-nostdin',
            '-y',
            '-ss',
            String(payload.startTime),
            '-i',
            input,
            '-t',
            String(payload.duration),
            '-vn',
            ...(payload.skipTranscode ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '128k']),
            '-progress',
            'pipe:1',
            '-nostats',
            output,
          ];
          await runMediaCommand(getFFmpegPath(), args, signal, (seconds) =>
            Context.current().heartbeat({ jobId: ref.jobId, stage: 'transcoding', seconds })
          );
          await saveArtifact(ref, 'processed', output, await measure(output, signal), signal);
          return { kind: 'ready' };
        });
      } catch (error) {
        Context.current().cancellationSignal.throwIfAborted();
        const evidence = (error as YouTubeAcquisitionError)?.youtubeAcquisitionEvidence;
        if (evidence) {
          const outcome = getYouTubeFailureDisposition(evidence);
          if (outcome.action === 'defer') return { kind: 'waiting_auth', recoveryGeneration: null };
          if (outcome.action === 'post_live_retry') return { kind: 'waiting_archive' };
          if (outcome.action === 'terminal') return { kind: 'restricted' };
        }
        // Provider exception messages may contain source URLs/tokens. Keep history sanitized.
        if (error instanceof ApplicationFailure) throw error;
        throw ApplicationFailure.create({
          message: 'Audio acquisition or transcoding failed',
          type: 'MEDIA_ACQUISITION_FAILED',
        });
      }
    },
    mergeMedia: async (ref) => {
      const eligible = await eligibility(ref);
      if (eligible.kind !== 'ready') return eligible;
      const request = await load(ref);
      if (request.artifacts?.final) {
        await verifyArtifact(request.artifacts.final);
        return { kind: 'ready' };
      }
      const processed = request.artifacts?.processed;
      if (!processed)
        throw ApplicationFailure.nonRetryable('Processed audio receipt is missing', 'MISSING_MEDIA_RECEIPT');
      if (!request.sources.intro && !request.sources.outro) {
        await verifyArtifact(processed);
        await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(requestDoc(ref));
          if (!snapshot.get('artifacts.final')) transaction.update(snapshot.ref, { 'artifacts.final': processed });
        });
        return { kind: 'ready' };
      }
      return withNativeActivity(ref, 'merging', async (directory, signal) => {
        await project(ref, 'merging', 85);
        const paths: string[] = [];
        for (const [index, source] of [
          request.sources.intro?.path,
          processed.path,
          request.sources.outro?.path,
        ].entries()) {
          if (!source) continue;
          const local = join(directory, `${index}.mp3`);
          await download(
            source,
            local,
            signal,
            index === 1
              ? processed.generation
              : index === 0
              ? request.sources.intro.generation
              : request.sources.outro.generation
          );
          paths.push(local);
        }
        const concat = join(directory, 'concat.txt');
        // All paths originate in our generated directory; no untrusted paths enter concat syntax.
        await writeFile(concat, paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'));
        const output = join(directory, 'final.mp3');
        const formats = await Promise.all(paths.map((path) => audioFormatSignature(path, signal)));
        const compatible = formats.every((format) => format === formats[0]);
        await runMediaCommand(
          getFFmpegPath(),
          [
            '-nostdin',
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concat,
            '-c:a',
            compatible ? 'copy' : 'libmp3lame',
            ...(compatible ? [] : ['-b:a', '128k']),
            '-progress',
            'pipe:1',
            '-nostats',
            output,
          ],
          signal
        );
        await saveArtifact(ref, 'final', output, await measure(output, signal), signal);
        return { kind: 'ready' };
      });
    },
    publishMedia: async (ref) => {
      const eligible = await eligibility(ref);
      if (eligible.kind !== 'ready') return eligible;
      const request = await load(ref);
      const processed = request.artifacts?.processed;
      const final = request.artifacts?.final;
      const source = request.artifacts?.source;
      if (!source || !processed || !final)
        throw ApplicationFailure.nonRetryable('Audio receipts are missing', 'MISSING_MEDIA_RECEIPT');
      await Promise.all([verifyArtifact(source), verifyArtifact(processed), verifyArtifact(final)]);
      await project(ref, 'publishing', 95);
      const result = await db.runTransaction(async (transaction) => {
        const [sermon, state, job] = await Promise.all([
          transaction.get(sermonDoc(ref)),
          transaction.get(stateDoc(ref)),
          transaction.get(db.collection('durableJobs').doc(ref.jobId)),
        ]);
        if (!sermon.exists) return { kind: 'deleted' } as const;
        if (state.data()?.owner !== 'temporal' || !matches(state.data()?.ref, ref))
          return { kind: 'superseded' } as const;
        if (
          state.get('cancellationJobId') === ref.jobId ||
          ['cancel_requested', 'cancelled'].includes(job.get('state'))
        )
          return { kind: 'cancelled' } as const;
        const canonicalRefDoc = db.collection('temporalMediaCanonicalRefs').doc(ref.sermonId);
        const previousRefs = (await transaction.get(canonicalRefDoc)).get('artifactIds') as
          | Record<string, string>
          | undefined;
        const artifactIds = {
          source: mediaArtifactId(ref.projectId, source.path),
          processed: mediaArtifactId(ref.projectId, processed.path),
          final: mediaArtifactId(ref.projectId, final.path),
        };
        const releases = await Promise.all(
          Object.entries(previousRefs ?? {}).map(([slot, artifactId]) =>
            prepareMediaReferenceRelease(transaction, db, {
              artifactId,
              projectId: ref.projectId,
              type: 'canonical',
              id: ref.sermonId,
              slot,
              releasedAt: Date.now(),
            })
          )
        );
        const attachments = await Promise.all(
          Object.entries(artifactIds).map(([slot, artifactId]) =>
            prepareMediaReference(transaction, db, {
              artifactId,
              projectId: ref.projectId,
              type: 'canonical',
              id: ref.sermonId,
              slot,
              createdAt: Date.now(),
            })
          )
        );
        releases.forEach((write) => write());
        attachments.forEach((write) => write());
        transaction.set(canonicalRefDoc, { projectId: ref.projectId, artifactIds });
        transaction.update(sermon.ref, {
          audioArtifacts: {
            jobId: ref.jobId,
            requestVersion: ref.requestVersion,
            revision: ref.revision,
            sourcePath: source.path,
            sourceDurationSeconds: source.duration,
            processedPath: processed.path,
            finalPath: final.path,
            durationSeconds: final.duration,
          },
          'status.audioStatus': 'PROCESSED',
          'status.message': 'Completed',
          durationSeconds: final.duration,
        });
        transaction.update(state.ref, { completedRef: ref, completedAt: new Date().toISOString() });
        return { kind: 'ready' } as const;
      });
      await dependencies.projectJob(ref, {
        state: result.kind === 'ready' ? 'succeeded' : result.kind === 'cancelled' ? 'cancelled' : 'superseded',
        progress: 100,
      });
      if (result.kind === 'ready')
        await realtime
          .ref(`addIntroOutro/${ref.sermonId}`)
          .transaction((current) => (current?.revision === ref.revision ? null : current));
      return result;
    },
    recoverMediaAuthentication: async (ref) => {
      if ((await eligibility(ref)).kind !== 'ready') return { ready: false, generation: null };
      return authenticationProbe(ref);
    },
    projectMediaWaiting: async (ref, reason, attempt) => {
      if ((await eligibility(ref)).kind !== 'ready') return;
      await dependencies.projectJob(ref, { state: 'waiting', reason, progress: 0 });
      await db.runTransaction(async (transaction) => {
        const [sermon, state] = await Promise.all([transaction.get(sermonDoc(ref)), transaction.get(stateDoc(ref))]);
        if (sermon.exists && matches(state.data()?.ref, ref))
          transaction.update(sermon.ref, {
            'status.audioStatus': 'PENDING',
            'status.message':
              reason === 'authentication'
                ? 'WAITING_FOR_YOUTUBE_AUTH: Waiting for YouTube authentication recovery.'
                : 'Waiting for YouTube to finish processing the livestream archive.',
            'audioProcessing.waitReason': reason,
            'audioProcessing.attempt': attempt,
          });
      });
    },
    projectMediaFailure: async (ref, code) => {
      const cancelled = code === 'CANCELLED' || code === 'SERMON_DELETED';
      const state = await stateDoc(ref).get();
      const superseded = code === 'SUPERSEDED' || !matches(state.get('ref'), ref);
      await dependencies.projectJob(ref, {
        state: superseded ? 'superseded' : cancelled ? 'cancelled' : 'failed',
        reason: code,
      });
      if (superseded) return;
      await db.runTransaction(async (transaction) => {
        const [sermon, state] = await Promise.all([transaction.get(sermonDoc(ref)), transaction.get(stateDoc(ref))]);
        if (sermon.exists && matches(state.data()?.ref, ref))
          transaction.update(sermon.ref, {
            'status.audioStatus': 'ERROR',
            'status.message': cancelled ? 'Audio processing cancelled.' : `Audio processing failed: ${code}`,
          });
      });
    },
    cleanupMedia: async (ref) => {
      // Successful artifacts remain immutable for playback. Remove only revision-owned UI progress.
      await realtime
        .ref(`addIntroOutro/${ref.sermonId}`)
        .transaction((current) => (current?.revision === ref.revision ? null : current));
      await db.runTransaction(async (transaction) => {
        const state = await transaction.get(stateDoc(ref));
        if (state.exists && matches(state.get('runningRef'), ref)) {
          // Null is intentional: merge-based admissions must not inherit ownership of a completed run.
          transaction.update(state.ref, { runningRef: null });
        }
      });
      if (
        ['succeeded', 'failed', 'cancelled', 'superseded'].includes(
          (await db.collection('durableJobs').doc(ref.jobId).get()).get('state')
        )
      )
        await releaseMediaJobArtifacts(db, ref);
    },
    registerMediaObserver: async (ref, workflowId) => {
      validRef(ref);
      if (typeof workflowId !== 'string' || !workflowId || workflowId.length > 1024)
        throw ApplicationFailure.nonRetryable('Invalid media observer reference', 'INVALID_MEDIA_OBSERVER');
      const id = createHash('sha256').update(workflowId).digest('hex');
      await requestDoc(ref).collection('observers').doc(id).set({ workflowId });
    },
    readMediaObservers: async (ref) => {
      validRef(ref);
      const observers = await requestDoc(ref).collection('observers').limit(100).get();
      return observers.docs
        .map((document) => document.get('workflowId'))
        .filter((value): value is string => typeof value === 'string');
    },
    readMediaCompletion: async (ref) => {
      validRef(ref);
      const [job, state, sermon] = await Promise.all([
        db.collection('durableJobs').doc(ref.jobId).get(),
        stateDoc(ref).get(),
        sermonDoc(ref).get(),
      ]);
      const status = job.get('state');
      if (status === 'succeeded') {
        // A newer revision must never be mistaken for this parent's required audio result.
        if (sermon.get('audioArtifacts.jobId') !== ref.jobId || !matches(state.get('ref'), ref))
          return { kind: 'superseded' };
        return { kind: 'succeeded' };
      }
      if (status === 'failed' || status === 'cancelled' || status === 'superseded') return { kind: status };
      return { kind: 'pending' };
    },
    requestMediaCancellation: async (ref) => {
      validRef(ref);
      await db.runTransaction(async (transaction) => {
        const jobDoc = db.collection('durableJobs').doc(ref.jobId);
        const [job, state] = await Promise.all([transaction.get(jobDoc), transaction.get(stateDoc(ref))]);
        const desired = state.get('ref') as MediaJobRef | undefined;
        const cancelQueued = state.get('deletionParentRef') && desired?.jobId !== ref.jobId && desired?.jobId;
        const pending = cancelQueued
          ? await transaction.get(db.collection('durableJobs').doc(desired!.jobId))
          : undefined;
        if (!job.exists || ['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.get('state'))) return;
        transaction.update(jobDoc, {
          state: 'cancel_requested',
          actions: [],
          revision: Number(job.get('revision')) + 1,
          updatedAt: Date.now(),
        });
        if (matches(state.get('ref'), ref)) transaction.update(state.ref, { cancellationJobId: ref.jobId });
        if (pending?.exists && !['succeeded', 'failed', 'cancelled', 'superseded'].includes(pending.get('state')))
          transaction.update(pending.ref, {
            state: 'cancelled',
            actions: [],
            revision: Number(pending.get('revision')) + 1,
            finishedAt: Date.now(),
            updatedAt: Date.now(),
          });
      });
    },
  };
}
