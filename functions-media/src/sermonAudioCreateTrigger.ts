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
  sermon: Sermon
): InitialAudioEnqueueDependencies => ({
  fileExists: async (path) => (await bucket.file(path).exists())[0],
  getDownloadUrl: async (path) => ensureFirebaseDownloadUrl(bucket.file(path)),
  enqueue: async (payload) => {
    const enqueue = () =>
      queueOrReplaceProcessAudioRequest({
        database: firebaseAdmin.database(),
        payload,
        targetUri:
          process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal'
            ? ''
            : getProcessAudioTargetUri('youtubeUrl' in payload ? 'youtube' : 'storage'),
        ownerId: `sermon-create:${eventId}`,
        onlyIfMissing: true,
      });
    if (process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal') return enqueue();
    const projectId = firebaseAdmin.app().options.projectId;
    if (!projectId) throw new Error('Firebase project is required.');
    const uploaderId = sermon.uploaderId;
    if (!uploaderId) throw new Error('Legacy source requires its admitted canonical uploader.');
    return withLegacyAdmissionLease(
      firebaseAdmin.firestore(),
      {
        projectId,
        domain: 'media',
        actorUid: 'system:firebase-event',
        operation: 'sermonaudiocreatetrigger',
        legacySourceUpload: {
          sermonId: payload.id,
          uploaderId,
          sourceStartTime: payload.startTime,
          trimDurationSeconds: payload.duration,
          ...('youtubeUrl' in payload ? { youtubeUrl: payload.youtubeUrl } : {}),
        },
      },
      async (lease) => {
        await lease.markEffectsStarted();
        return enqueue();
      }
    );
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
  if (!current.exists) return;
  const sermon = current.data() as Sermon;
  const result = await enqueueInitialSermonAudio(
    event.params.sermonId,
    sermon,
    createProductionDependencies(firebaseAdmin.storage().bucket(), event.id, sermon)
  );

  logger.info('Reconciled initial sermon audio queue request', {
    sermonId: event.params.sermonId,
    action: result.action,
    ...(result.action === 'enqueued' ? { queueAction: result.queueAction } : { reason: result.reason }),
  });
});

export default sermonAudioCreateTrigger;
