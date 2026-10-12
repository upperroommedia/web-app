import type { Bucket } from '@google-cloud/storage';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Sermon, sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { ensureFirebaseDownloadUrl } from '../../functions/src/storageDownloadUrl';
import { getProcessAudioTargetUri } from './processAudioService';
import { queueOrReplaceProcessAudioRequest } from './processAudioQueueStore';

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

const createProductionDependencies = (bucket: Bucket, eventId: string): InitialAudioEnqueueDependencies => ({
  fileExists: async (path) => (await bucket.file(path).exists())[0],
  getDownloadUrl: async (path) => ensureFirebaseDownloadUrl(bucket.file(path)),
  enqueue: async (payload) =>
    queueOrReplaceProcessAudioRequest({
      database: firebaseAdmin.database(),
      payload,
      targetUri: getProcessAudioTargetUri('youtubeUrl' in payload ? 'youtube' : 'storage'),
      ownerId: `sermon-create:${eventId}`,
      onlyIfMissing: true,
    }),
});

const sermonAudioCreateTrigger = onDocumentCreated({ document: 'sermons/{sermonId}', retry: true }, async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    return;
  }

  const result = await enqueueInitialSermonAudio(
    event.params.sermonId,
    snapshot.data() as Sermon,
    createProductionDependencies(firebaseAdmin.storage().bucket(), event.id)
  );

  logger.info('Reconciled initial sermon audio queue request', {
    sermonId: event.params.sermonId,
    action: result.action,
    ...(result.action === 'enqueued' ? { queueAction: result.queueAction } : { reason: result.reason }),
  });
});

export default sermonAudioCreateTrigger;
