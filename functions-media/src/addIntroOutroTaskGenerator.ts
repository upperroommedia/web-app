import { TaskOptions, getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import handleError from '../../functions/src/handleError';
import { emitOperationalAlert } from '../../functions/src/notifications/emitOperationalAlert';
import {
  getAudioSource,
  PROCESS_AUDIO_TASK_QUEUE_NAME,
  PROCESS_AUDIO_TASK_TIMEOUT_SECONDS,
  validateAddIntroOutroData,
} from './audioTaskPayload';
import { getProcessAudioTargetUri } from './processAudioService';

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
  const bucket = firebaseAdmin.storage().bucket();
  const db = firebaseAdmin.firestore();
  const docRef = db.collection('sermons').doc(data.id);
  const targetUri = getProcessAudioTargetUri();

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

    const queue = getFunctions().taskQueue(PROCESS_AUDIO_TASK_QUEUE_NAME);
    const taskOptions: TaskOptions = {
      dispatchDeadlineSeconds: PROCESS_AUDIO_TASK_TIMEOUT_SECONDS,
      uri: targetUri,
    };

    logger.info('Enqueueing process-audio task', {
      queueName: PROCESS_AUDIO_TASK_QUEUE_NAME,
      targetUri,
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
    });

    return await queue.enqueue(data, taskOptions);
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
          taskRoute: PROCESS_AUDIO_TASK_QUEUE_NAME,
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
        taskRoute: PROCESS_AUDIO_TASK_QUEUE_NAME,
        targetUri,
      },
    });
  }
});

export default addintrooutrotaskgenerator;
