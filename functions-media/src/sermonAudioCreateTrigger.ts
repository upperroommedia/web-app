import type { Bucket } from '@google-cloud/storage';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Sermon, sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { ensureFirebaseDownloadUrl } from '../../functions/src/storageDownloadUrl';
import { getProcessAudioTargetUri } from './processAudioService';
import { queueOrReplaceProcessAudioRequest } from './processAudioQueueStore';
import { withLegacyAdmissionLease } from '../../functions/src/temporal/legacyAdmissionLease';

type InitialAudioEnqueueDependencies = {
  fileExists: (path: string) => Promise<boolean>;
  getDownloadUrl: (path: string) => Promise<string>;
  enqueue: (payload: AddIntroOutroInputType) => Promise<{ action: string }>;
};

export type InitialAudioEnqueueResult =
  | { action: 'skipped'; reason: 'not_pending' | 'invalid_trim_settings' }
  | { action: 'enqueued'; queueAction: string };

const getBumperPath = async (
  kind: 'intro' | 'outro',
  subtitle: string,
  fileExists: InitialAudioEnqueueDependencies['fileExists']
): Promise<string> => {
  const specificPath = `${kind}s/${subtitle}_${kind}.mp3`;
  if (subtitle && (await fileExists(specificPath))) {
    return specificPath;
  }
  return `${kind}s/default_${kind}.mp3`;
};

export const enqueueInitialSermonAudio = async (
  sermonId: string,
  sermon: Sermon,
  dependencies: InitialAudioEnqueueDependencies
): Promise<InitialAudioEnqueueResult> => {
  // Source-session confirmation atomically starts its own media job after bytes are verified.
  if ((sermon as Sermon & { activeDurableJobs?: { upload?: unknown } }).activeDurableJobs?.upload) {
    return { action: 'skipped', reason: 'not_pending' };
  }
  if (sermon.status?.audioStatus !== sermonStatusType.PENDING) {
    return { action: 'skipped', reason: 'not_pending' };
  }

  if (
    !Number.isFinite(sermon.sourceStartTime) ||
    sermon.sourceStartTime < 0 ||
    !Number.isFinite(sermon.trimDurationSeconds) ||
    (sermon.trimDurationSeconds ?? 0) <= 0
  ) {
    return { action: 'skipped', reason: 'invalid_trim_settings' };
  }

  const [introPath, outroPath] = await Promise.all([
    getBumperPath('intro', sermon.subtitle, dependencies.fileExists),
    getBumperPath('outro', sermon.subtitle, dependencies.fileExists),
  ]);
  const [introUrl, outroUrl] = await Promise.all([
    dependencies.getDownloadUrl(introPath),
    dependencies.getDownloadUrl(outroPath),
  ]);
  const basePayload = {
    id: sermonId,
    startTime: sermon.sourceStartTime,
    duration: sermon.trimDurationSeconds as number,
    deleteOriginal: true,
    introUrl,
    outroUrl,
  };

  let payload: AddIntroOutroInputType;
  if (typeof sermon.youtubeUrl === 'string' && sermon.youtubeUrl.trim()) {
    payload = { ...basePayload, youtubeUrl: sermon.youtubeUrl.trim() };
  } else {
    const storageFilePath = `sermons/${sermonId}`;
    if (!(await dependencies.fileExists(storageFilePath))) {
      throw new Error(`Initial sermon audio source is not available for ${sermonId}.`);
    }
    payload = { ...basePayload, storageFilePath };
  }

  const result = await dependencies.enqueue(payload);
  return { action: 'enqueued', queueAction: result.action };
};

const createProductionDependencies = (
  bucket: Bucket,
  eventId: string,
  legacyAdmissionLeaseId?: string
): InitialAudioEnqueueDependencies => ({
  fileExists: async (path) => (await bucket.file(path).exists())[0],
  getDownloadUrl: async (path) => ensureFirebaseDownloadUrl(bucket.file(path)),
  enqueue: async (payload) => {
    // The old browser completed file bytes before creating its canonical row.
    // Capture only the configured bucket's exact original object identity; the
    // shared source authority rejects a later overwrite by native creation time.
    const original =
      'storageFilePath' in payload && legacyAdmissionLeaseId
        ? (await bucket.file(payload.storageFilePath).getMetadata())[0]
        : undefined;
    return queueOrReplaceProcessAudioRequest({
      database: firebaseAdmin.database(),
      payload,
      targetUri:
        process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal'
          ? ''
          : getProcessAudioTargetUri('youtubeUrl' in payload ? 'youtube' : 'storage'),
      ownerId: `sermon-create:${eventId}`,
      onlyIfMissing: true,
      legacyAdmissionLeaseId,
      ...('storageFilePath' in payload && original
        ? {
            legacyConfiguredSourceBucket: bucket.name,
            legacyOriginalStorageSource: {
              kind: 'storage' as const,
              bucket: original.bucket!,
              path: original.name!,
              generation: String(original.generation ?? ''),
              timeCreated: original.timeCreated!,
            },
          }
        : {}),
    });
  },
});

const sermonAudioCreateTrigger = onDocumentCreated({ document: 'sermons/{sermonId}', retry: true }, async (event) => {
  const snapshot = event.data;
  if (!snapshot || !snapshot.exists) {
    // The Firestore emulator can emit a phantom create whose protobuf contains
    // only an empty updateMask during fixture cleanup. It is not pending work.
    // A missing production create payload is a delivery failure and must retry.
    if (process.env.FUNCTIONS_EMULATOR === 'true' && snapshot && !snapshot.exists) {
      logger.warn('Ignored emulator create event without a document', {
        sermonId: event.params.sermonId,
        eventId: event.id,
      });
      return;
    }
    throw new Error('Created sermon event has no document.');
  }

  const created = snapshot.data() as Sermon;
  // Durable source confirmations own their enqueue and need no legacy continuation lookup.
  const durableSource = (created as Sermon & { activeDurableJobs?: { upload?: unknown } }).activeDurableJobs?.upload;
  const current = durableSource ? snapshot : await snapshot.ref.get();
  if (!current.exists || !current.createTime?.isEqual(snapshot.createTime!)) return;
  const sermon = current.data() as Sermon;
  const enqueue = (leaseId?: string) =>
    enqueueInitialSermonAudio(
      event.params.sermonId,
      sermon,
      createProductionDependencies(firebaseAdmin.storage().bucket(), event.id, leaseId)
    );
  let result: InitialAudioEnqueueResult;
  if (
    !Number.isFinite(sermon.sourceStartTime) ||
    sermon.sourceStartTime < 0 ||
    !Number.isFinite(sermon.trimDurationSeconds) ||
    (sermon.trimDurationSeconds ?? 0) <= 0
  ) {
    result = { action: 'skipped', reason: 'invalid_trim_settings' };
  } else if (
    process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal' ||
    durableSource ||
    sermon.status?.audioStatus !== sermonStatusType.PENDING
  ) {
    // The durable path resolves canonical sources without writing public download tokens.
    if (
      process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal' &&
      !durableSource &&
      sermon.status?.audioStatus === sermonStatusType.PENDING
    ) {
      const { submitServerDurableJob } = await import('../../functions/src/temporal/bridge');
      await submitServerDurableJob({
        kind: 'audio.process',
        entity: { type: 'sermon', id: event.params.sermonId },
        actorUid: 'system:firebase-event',
        requestId: `sermon-create:${event.id}`,
        payload: { startTime: sermon.sourceStartTime, duration: sermon.trimDurationSeconds },
      });
      result = { action: 'enqueued', queueAction: 'durable' };
    } else result = await enqueue();
  } else {
    const projectId = firebaseAdmin.app().options.projectId;
    if (!projectId || !created.uploaderId)
      throw new Error('Legacy source requires its canonical project and uploader.');
    result = await withLegacyAdmissionLease(
      firebaseAdmin.firestore(),
      {
        projectId,
        domain: 'media',
        actorUid: 'system:firebase-event',
        operation: 'sermonaudiocreatetrigger',
        legacySourceUpload: {
          sermonId: event.params.sermonId,
          // Bind the immutable create snapshot, not a later edited canonical
          // selection. The transaction compares it with the current document
          // before bumper-token writes or queue effects can begin.
          uploaderId: created.uploaderId,
          sourceStartTime: created.sourceStartTime,
          trimDurationSeconds: created.trimDurationSeconds!,
          ...(created.youtubeUrl?.trim() ? { youtubeUrl: created.youtubeUrl.trim() } : {}),
        },
      },
      async (lease) => {
        // Bumper URL resolution may persist a download token: admission must precede it.
        await lease.markEffectsStarted();
        return enqueue(lease.leaseId);
      }
    );
  }

  logger.info('Reconciled initial sermon audio queue request', {
    sermonId: event.params.sermonId,
    action: result.action,
    ...(result.action === 'enqueued' ? { queueAction: result.queueAction } : { reason: result.reason }),
  });
});

export default sermonAudioCreateTrigger;
