import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import handleError from '../../functions/src/handleError';
import { emitOperationalAlert } from '../../functions/src/notifications/emitOperationalAlert';
import { getAudioSource, validateAddIntroOutroData } from './audioTaskPayload';
import { getProcessAudioTargetUri } from './processAudioService';
import { queueOrReplaceProcessAudioRequest } from './processAudioQueueStore';
import {
  computeProcessAudioRequestVersion,
  getProcessAudioTaskQueueNameForSource,
} from '@upperroom/contracts/processAudioQueue';
import { withLegacyAdmissionLease } from '../../functions/src/temporal/legacyAdmissionLease';

const addintrooutrotaskgenerator = onCall(
  { invoker: 'public' },
  async (request: CallableRequest<AddIntroOutroInputType>): Promise<void> => {
    const data = request.data;
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to process audio.');
    const role = String(request.auth.token.role ?? '');
    if (!['admin', 'publisher', 'uploader'].includes(role))
      throw new HttpsError('permission-denied', 'Upload permission is required.');

    if (!validateAddIntroOutroData(data)) {
      throw new HttpsError(
        'invalid-argument',
        `Invalid data: data must be an object with the following field:
       id (string),
       startTime (number),
       duration (number),
       youtubeUrl (string) || storageFilePath (string),
       introUrl (string),
       outroUrl (string)`
      );
    }

    const audioSource = getAudioSource(data);
    const sourceType = audioSource.type === 'YouTubeUrl' ? 'youtube' : 'storage';
    const taskQueueName = getProcessAudioTaskQueueNameForSource(sourceType);
    const bucket = firebaseAdmin.storage().bucket();
    const db = firebaseAdmin.firestore();
    const docRef = db.collection('sermons').doc(data.id);
    const existing = await docRef.get();
    if (!existing.exists) throw new HttpsError('not-found', 'Sermon no longer exists.');
    if (role !== 'admin' && existing.get('uploaderId') !== request.auth.uid)
      throw new HttpsError('permission-denied', 'You cannot process this sermon.');
    if (process.env.TASK_ORCHESTRATOR_MEDIA === 'temporal') {
      const { submitServerDurableJob } = await import('../../functions/src/temporal/bridge');
      // The durable facade resolves sources and bumpers from canonical server-owned state.
      await submitServerDurableJob({
        kind: 'audio.process',
        entity: { type: 'sermon', id: data.id },
        actorUid: request.auth.uid,
        requestId: `legacy-audio:${computeProcessAudioRequestVersion(data)}`,
        payload: {
          startTime: data.startTime,
          duration: data.duration,
          ...(data.skipTranscode ? { skipTranscode: true } : {}),
        },
      });
      return;
    }
    if (audioSource.type === 'StorageFilePath') {
      const allowed = [
        `sermons/${data.id}`,
        `processed-sermons/${data.id}`,
        `intro-outro-sermons/${data.id}`,
        existing.get('audioArtifacts.sourcePath'),
        existing.get('audioArtifacts.processedPath'),
        existing.get('audioArtifacts.finalPath'),
      ];
      if (!allowed.includes(audioSource.source))
        throw new HttpsError('permission-denied', 'Audio source does not belong to this sermon.');
    }
    const targetUri = getProcessAudioTargetUri(sourceType);

    try {
      if (audioSource.type === 'StorageFilePath') {
        const [fileExists] = await bucket.file(audioSource.source).exists();
        if (!fileExists) {
          const errorMessage = `${audioSource.source} could not be found`;
          logger.error('Invalid Argument', errorMessage);
          throw new HttpsError('invalid-argument', errorMessage);
        }
      }

      const projectId = firebaseAdmin.app().options.projectId;
      if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is required.');
      const queueResult = await withLegacyAdmissionLease(
        db,
        { projectId, domain: 'media', actorUid: request.auth.uid, operation: 'addintrooutrotaskgenerator' },
        async (lease) => {
          await lease.markEffectsStarted();
          const object =
            audioSource.type === 'StorageFilePath'
              ? (await bucket.file(audioSource.source).getMetadata())[0]
              : undefined;
          await docRef.update({ 'status.audioStatus': sermonStatusType.PENDING });
          return queueOrReplaceProcessAudioRequest({
            database: firebaseAdmin.database(),
            payload: data,
            targetUri,
            ownerId: `enqueue:${data.id}:${Date.now()}`,
            actorUid: request.auth!.uid,
            ...(object
              ? {
                  legacyConfiguredSourceBucket: bucket.name,
                  legacyOriginalStorageSource: {
                    kind: 'storage' as const,
                    bucket: object.bucket!,
                    path: object.name!,
                    generation: String(object.generation ?? ''),
                    timeCreated: object.timeCreated!,
                  },
                }
              : {}),
          });
        }
      );

      logger.info('Updated process-audio queue state', {
        action: queueResult.action,
        requestVersion: queueResult.requestVersion,
        taskId: 'taskId' in queueResult ? queueResult.taskId : null,
        sourceType: queueResult.sourceType,
        taskQueueName,
        targetUri,
        projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
      });

      return;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error(error);

      try {
        await emitOperationalAlert({
          alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
          summary: 'addintrooutrotaskgenerator failed to enqueue a process-audio task.',
          error,
          context: {
            functionName: 'addintrooutrotaskgenerator',
            sermonId: data.id,
            audioSourceType: audioSource.type,
            audioSource: audioSource.source,
            taskRoute: taskQueueName,
            targetUri,
          },
        });
      } catch (alertError) {
        logger.error('Failed to emit operational alert for addintrooutrotaskgenerator', {
          alertError,
          originalError: error,
        });
      }

      throw handleError(error, {
        request,
        alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
        summary: 'addintrooutrotaskgenerator failed to enqueue a process-audio task.',
        context: {
          functionName: 'addintrooutrotaskgenerator',
          sermonId: data.id,
          audioSourceType: audioSource.type,
          audioSource: audioSource.source,
          taskRoute: taskQueueName,
          targetUri,
        },
      });
    }
  }
);

export default addintrooutrotaskgenerator;
