import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import handleError from '../../functions/src/handleError';
import { emitOperationalAlert } from '../../functions/src/notifications/emitOperationalAlert';
import {
  getAudioSource,
  validateAddIntroOutroData,
} from './audioTaskPayload';
import { getProcessAudioTargetUri } from './processAudioService';
import { queueOrReplaceProcessAudioRequest } from './processAudioQueueStore';
import { getProcessAudioTaskQueueNameForSource } from '@upperroom/contracts/processAudioQueue';

const addintrooutrotaskgenerator = onCall({ invoker: 'public' }, async (request: CallableRequest<AddIntroOutroInputType>): Promise<void> => {
  const data = request.data;

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

    await docRef.update({ 'status.audioStatus': sermonStatusType.PENDING });

    const queueResult = await queueOrReplaceProcessAudioRequest({
      database: firebaseAdmin.database(),
      payload: data,
      targetUri,
      ownerId: `enqueue:${data.id}:${Date.now()}`,
    });

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
});

export default addintrooutrotaskgenerator;
