import { entityLabel } from '../../../functions/src/temporal/displayLabel';
import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  mediaArtifactId,
  prepareMediaReference,
  prepareMediaReferenceRelease,
} from '../../../packages/orchestration/src/media-artifacts';
import {
  computeProcessAudioRequestVersion,
  getProcessAudioSourceType,
  sanitizeProcessAudioPayload,
} from '@upperroom/contracts/processAudioQueue';

export interface MediaReference {
  jobId: string;
  projectId: string;
  sermonId: string;
  revision: number;
  requestVersion: string;
}
export interface MediaOutboxAdmission {
  ref: MediaReference;
  kind: 'audio.process';
  entity: { type: 'sermon'; id: string; label?: string };
  actorUid: string;
  payload: Record<string, unknown>;
  requestId: string;
  generation: number;
  dispatch: {
    workflowType: 'SermonAudioCoordinator';
    workflowId: string;
    taskQueue: string;
    ref: MediaReference;
    signal: { name: 'media.request'; args: MediaReference };
    startArgs: { initial: MediaReference; mediaTaskQueue: string };
  };
  createdAt: number;
}
interface Dependencies {
  firestore: Firestore;
  bucket: Bucket;
  projectId: string;
  coordinatorTaskQueue: string;
  mediaTaskQueue: string;
  assertLegacyDrained: (sermonId: string) => Promise<void>;
  enqueueInTransaction: (transaction: Transaction, admission: MediaOutboxAdmission) => void;
  assertParentCurrentInTransaction?: (transaction: Transaction, ref: DurableJobRef) => Promise<unknown>;
  assertAdmissionReleaseInTransaction?: (transaction: Transaction, continuation: boolean) => Promise<unknown>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function validatePayload(payload: AddIntroOutroInputType): void {
  if (
    !payload ||
    typeof payload.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(payload.id) ||
    !Number.isFinite(payload.startTime) ||
    payload.startTime < 0 ||
    payload.startTime > 86400 ||
    !Number.isFinite(payload.duration) ||
    payload.duration <= 0 ||
    payload.duration > 86400 ||
    'youtubeUrl' in payload === 'storageFilePath' in payload
  )
    throw new Error('Invalid media processing request.');
  if ('youtubeUrl' in payload) {
    if (typeof payload.youtubeUrl !== 'string') throw new Error('Invalid YouTube source.');
    if (!/^[A-Za-z0-9_-]{11}$/.test(payload.youtubeUrl)) {
      const url = new URL(payload.youtubeUrl);
      if (
        url.protocol !== 'https:' ||
        !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)
      )
        throw new Error('Invalid YouTube source.');
    }
  } else if (typeof payload.storageFilePath !== 'string' || !payload.storageFilePath)
    throw new Error('Invalid media source.');
  for (const value of [payload.introUrl, payload.outroUrl])
    if (value !== undefined && (typeof value !== 'string' || !value)) throw new Error('Invalid bumper source.');
  for (const value of [payload.skipTranscode, payload.deleteOriginal])
    if (value !== undefined && typeof value !== 'boolean') throw new Error('Invalid media processing option.');
}

function bucketPath(value: string, bucket: string): string {
  if (!value.includes('://')) return value;
  const url = new URL(value);
  if (url.protocol === 'gs:' && url.hostname === bucket) return decodeURIComponent(url.pathname.slice(1));
  if (url.protocol === 'https:' && url.hostname === 'firebasestorage.googleapis.com') {
    const match = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
    if (match && decodeURIComponent(match[1]) === bucket) return decodeURIComponent(match[2]);
  }
  if (url.protocol === 'https:' && url.hostname === 'storage.googleapis.com' && url.pathname.startsWith(`/${bucket}/`))
    return decodeURIComponent(url.pathname.slice(bucket.length + 2));
  throw new Error('Media source must belong to the application storage bucket.');
}

/** Firestore intent + desired revision + broker outbox are committed atomically. */
export function createMediaAdmission(dependencies: Dependencies) {
  return async (args: {
    payload: AddIntroOutroInputType;
    actorUid: string;
    requestId: string;
    onlyIfMissing?: boolean;
    expectedSourceGeneration?: string;
    sourceUploadJobId?: string;
    publicInputHash?: string;
    parentJobRef?: DurableJobRef;
  }) => {
    const { firestore: db, bucket, projectId } = dependencies;
    validatePayload(args.payload);
    const payload = sanitizeProcessAudioPayload(args.payload);
    const requestVersion = computeProcessAudioRequestVersion(payload);
    const sourceType = getProcessAudioSourceType(payload);
    const sermonRef = db.collection('sermons').doc(payload.id);
    const stateRef = db.collection('temporalMediaState').doc(payload.id);
    const intentKey = hash(JSON.stringify([projectId, args.actorUid, payload.id, args.requestId]));
    const dedupRef = db.collection('temporalMediaAdmissions').doc(intentKey);
    const receiptRef = db
      .collection('durableAdmissionReceipts')
      .doc(hash(JSON.stringify([projectId, args.actorUid, args.requestId])));
    const sourceSessionRef = args.sourceUploadJobId
      ? db.collection('durableUploadSessions').doc(args.sourceUploadJobId)
      : undefined;
    const sourceJobRef = args.sourceUploadJobId ? db.collection('durableJobs').doc(args.sourceUploadJobId) : undefined;
    await dependencies.assertLegacyDrained(payload.id);
    const sources: Record<string, { path: string; generation: string }> = {};
    for (const [key, source] of [
      ['storage', 'storageFilePath' in payload ? payload.storageFilePath : undefined],
      ['intro', payload.introUrl],
      ['outro', payload.outroUrl],
    ] as const) {
      if (!source) continue;
      const path = bucketPath(source, bucket.name);
      if (!path || path.includes('..') || path.startsWith('/')) throw new Error('Invalid media object path.');
      const [metadata] = await bucket.file(path).getMetadata();
      if (!metadata.generation || Number(metadata.size) <= 0) throw new Error('Media source is unavailable.');
      if (
        key === 'storage' &&
        args.expectedSourceGeneration &&
        String(metadata.generation) !== args.expectedSourceGeneration
      )
        throw new Error('Uploaded media source generation changed.');
      sources[key] = { path, generation: String(metadata.generation) };
    }
    const inputHash = hash(JSON.stringify({ requestVersion, sources }));
    return db.runTransaction(async (transaction) => {
      if (args.parentJobRef) {
        if (args.parentJobRef.projectId !== projectId || !dependencies.assertParentCurrentInTransaction)
          throw new Error('Publishing parent reference is unavailable.');
        const parent = await transaction.get(db.collection('durableJobs').doc(args.parentJobRef.jobId));
        if (
          !parent.exists ||
          parent.get('requestedBy') !== args.actorUid ||
          ['succeeded', 'failed', 'cancel_requested', 'cancelled', 'superseded'].includes(parent.get('state'))
        )
          throw new Error('Publishing parent was cancelled or superseded.');
        await dependencies.assertParentCurrentInTransaction(transaction, args.parentJobRef);
        const dependency = await transaction.get(
          db.collection('temporalPublishingAudioDependencies').doc(args.parentJobRef.jobId)
        );
        if (dependency.exists) {
          if (dependency.get('projectId') !== projectId) throw new Error('Publishing dependency project mismatch.');
          return { action: 'unchanged' as const, ref: dependency.get('mediaRef') as MediaReference, sourceType };
        }
      }
      const [sermon, state, admission, sourceSession, sourceJob, receipt] = await Promise.all([
        transaction.get(sermonRef),
        transaction.get(stateRef),
        transaction.get(dedupRef),
        sourceSessionRef ? transaction.get(sourceSessionRef) : undefined,
        sourceJobRef ? transaction.get(sourceJobRef) : undefined,
        transaction.get(receiptRef),
      ]);
      if (!sermon.exists) throw new Error('Sermon no longer exists.');
      if (
        receipt.exists &&
        (receipt.get('actorUid') !== args.actorUid ||
          receipt.get('projectId') !== projectId ||
          receipt.get('mediaInputHash') !== inputHash ||
          (args.publicInputHash && receipt.get('inputHash') !== args.publicInputHash))
      )
        throw new Error('Request ID was already used for different media input.');
      if (args.sourceUploadJobId) {
        if (
          !sourceSession?.exists ||
          !sourceJob?.exists ||
          sourceSession.get('projectId') !== projectId ||
          sourceJob.get('projectId') !== projectId ||
          sourceSession.get('actorUid') !== args.actorUid ||
          sourceJob.get('requestedBy') !== args.actorUid ||
          sourceSession.get('sermonId') !== payload.id
        )
          throw new Error('Upload session is unavailable.');
        const confirmedRef = sourceSession.get('mediaJobRef') as MediaReference | undefined;
        if (confirmedRef) return { action: 'unchanged' as const, ref: confirmedRef, sourceType };
        if (
          sourceJob.get('state') !== 'awaiting_source' ||
          !['awaiting_source', 'ready'].includes(sourceSession.get('state'))
        )
          throw new Error('Upload was cancelled or already completed.');
      }
      const previous = state.data()?.ref as MediaReference | undefined;
      if (admission.exists) {
        if (admission.get('inputHash') !== inputHash)
          throw new Error('Request ID was already used for different media input.');
        return { action: 'unchanged' as const, ref: admission.data()?.ref as MediaReference, sourceType };
      }
      if (args.onlyIfMissing && previous?.requestVersion === requestVersion)
        return { action: 'unchanged' as const, ref: previous, sourceType };
      await dependencies.assertAdmissionReleaseInTransaction?.(
        transaction,
        Boolean(args.sourceUploadJobId || args.parentJobRef)
      );
      if (state.get('deletionParentRef'))
        throw new Error('Sermon deletion is in progress. Audio processing is unavailable.');
      // Cutover must drain legacy work before assigning this resource to Temporal.
      if (state.exists && state.data()?.owner !== 'temporal')
        throw new Error('Media orchestration ownership is transitioning.');
      const previousJob = previous
        ? await transaction.get(db.collection('durableJobs').doc(previous.jobId))
        : undefined;
      const revision = (previous?.revision ?? 0) + 1;
      const ref: MediaReference = {
        projectId,
        sermonId: payload.id,
        revision,
        requestVersion,
        jobId: `audio-${intentKey.slice(0, 40)}`,
      };
      const createdAt = Date.now();
      const sourceReferences = await Promise.all(
        Object.values(sources)
          .filter((source) => source.path.startsWith(`workflow-audio/${payload.id}/`))
          .map((source) =>
            prepareMediaReference(transaction, db, {
              artifactId: mediaArtifactId(projectId, source.path),
              projectId,
              type: 'media_job',
              id: ref.jobId,
              createdAt,
            })
          )
      );
      const replacePending =
        previousJob?.exists &&
        state.get('runningRef')?.jobId !== previous?.jobId &&
        !['succeeded', 'failed', 'cancelled', 'superseded'].includes(previousJob.get('state'));
      const priorArtifacts = replacePending
        ? await transaction.get(
            db.collection('temporalMediaJobArtifacts').doc(previous!.jobId).collection('artifacts').limit(101)
          )
        : undefined;
      if (priorArtifacts && priorArtifacts.size > 100)
        throw new Error('Previous media artifact references require review.');
      const releasePending = await Promise.all(
        (priorArtifacts?.docs ?? []).map((artifact) =>
          prepareMediaReferenceRelease(transaction, db, {
            artifactId: artifact.id,
            projectId,
            type: 'media_job',
            id: previous!.jobId,
            releasedAt: createdAt,
          })
        )
      );
      transaction.create(db.collection('temporalMediaRequests').doc(ref.jobId), { ref, payload, sources, createdAt });
      transaction.set(stateRef, {
        owner: 'temporal',
        ref,
        updatedAt: createdAt,
        ...(state.get('runningRef') ? { runningRef: state.get('runningRef') } : {}),
      });
      if (
        previousJob?.exists &&
        state.get('runningRef')?.jobId !== previous?.jobId &&
        !['succeeded', 'failed', 'cancelled', 'superseded'].includes(previousJob.get('state'))
      ) {
        transaction.update(previousJob.ref, {
          state: 'superseded',
          actions: [],
          finishedAt: createdAt,
          updatedAt: createdAt,
          revision: Number(previousJob.get('revision')) + 1,
        });
      }
      transaction.create(dedupRef, { ref, inputHash, createdAt });
      sourceReferences.forEach((write) => write());
      releasePending.forEach((write) => write());
      transaction.update(sermonRef, {
        'status.audioStatus': 'PENDING',
        'status.message': 'Queued for audio processing.',
      });
      if (args.parentJobRef)
        transaction.create(db.collection('temporalPublishingAudioDependencies').doc(args.parentJobRef.jobId), {
          parentJobId: args.parentJobRef.jobId,
          projectId,
          mediaRef: ref,
          createdAt,
        });
      if (sourceSessionRef && sourceJobRef && sourceJob) {
        transaction.update(sourceSessionRef, {
          state: 'confirmed',
          mediaJobRef: ref,
          ...(args.expectedSourceGeneration ? { sourceGeneration: args.expectedSourceGeneration } : {}),
          confirmedAt: createdAt,
        });
        transaction.update(sourceJobRef, {
          state: 'succeeded',
          actions: [],
          finishedAt: createdAt,
          updatedAt: createdAt,
          revision: Number(sourceJob.get('revision')) + 1,
          result: { sermonId: payload.id, mediaJobId: ref.jobId, mediaJobRef: { jobId: ref.jobId, projectId } },
        });
      }
      dependencies.enqueueInTransaction(transaction, {
        ref,
        kind: 'audio.process',
        entity: { type: 'sermon', id: payload.id, ...entityLabel(sermon.get('title')) },
        actorUid: args.actorUid,
        payload: { mediaRequestId: ref.jobId },
        requestId: args.requestId,
        generation: revision,
        createdAt,
        dispatch: {
          ref,
          workflowType: 'SermonAudioCoordinator',
          workflowId: `audio:${projectId}:${payload.id}`,
          taskQueue: dependencies.coordinatorTaskQueue,
          signal: { name: 'media.request', args: ref },
          startArgs: { initial: ref, mediaTaskQueue: dependencies.mediaTaskQueue },
        },
      });
      transaction.create(receiptRef, {
        actorUid: args.actorUid,
        projectId,
        inputHash: args.publicInputHash ?? inputHash,
        mediaInputHash: inputHash,
        createdAt,
        receipt: {
          jobId: ref.jobId,
          projectId,
          requestId: args.requestId,
          admissionState: 'queued',
          revision: 1,
          generation: revision,
        },
      });
      return { action: 'queued' as const, ref, sourceType };
    });
  };
}
