import { getFunctions } from 'firebase-admin/functions';
import { grantNativeMosesBacklogEdit, queueCompletedBacklogEdit } from './mosesBacklogEdit';
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
import { MOSES_BACKLOG_DOCUMENT_FENCES } from '@upperroom/contracts/mosesDeferredRecovery';
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

    const queueResult = await queueOrReplaceProcessAudioRequest({
      database: firebaseAdmin.database(),
      authorizedBacklogEdit: async (fence, claimOwner) => {
        const user = request.auth;
        const options = firebaseAdmin.app().options;
        const route = sourceType === 'youtube' ? 'https://yt-worker.upperroommedia.org/process-audio' :
          'https://process-audio-yshbijirxq-uc.a.run.app/process-audio';
        if (!user || options.projectId !== 'urm-app' || options.storageBucket !== 'urm-app.appspot.com' ||
            !['https://urm-app-default-rtdb.firebaseio.com', 'https://urm-app-default-rtdb.firebaseio.com/'].includes(options.databaseURL ?? '') ||
            targetUri !== route || process.env.GCLOUD_PROJECT !== 'urm-app' || process.env.NODE_ENV !== 'production' ||
            Object.keys(process.env).some(k => k === 'FUNCTIONS_EMULATOR' || k.endsWith('_EMULATOR_HOST')))
          throw new HttpsError('failed-precondition', 'Recovered audio requires an authorized production edit.');
        try {
          return await queueCompletedBacklogEdit(fence, data, claimOwner, {
            database: firebaseAdmin.database(), editor: { uid: user.uid, role: user.token.role },
            authorize: (args) => grantNativeMosesBacklogEdit(db, bucket, args),
            enqueue: (edited, taskId, nonce) => getFunctions().taskQueue<AddIntroOutroInputType>(taskQueueName).enqueue(edited, {
              id: taskId, uri: route, dispatchDeadlineSeconds: 1800, headers: { 'x-urm-moses-pilot-intent': nonce },
            }),
          });
        } catch {
          // SDK errors may contain the private task header or signed storage URLs.
          throw new HttpsError('failed-precondition', 'The authorized edit could not be confirmed. Inspect its existing task before retrying.');
        }
      },
      markPending: async () => {
        await db.runTransaction(async tx => {
          const fence = await tx.get(db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(data.id));
          if (fence.exists) throw new HttpsError('failed-precondition', 'Recovery owns this original upload.');
          tx.update(docRef, { 'status.audioStatus': sermonStatusType.PENDING });
        });
      },
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
