import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
// import { GoogleAuth } from 'google-auth-library';
import { TaskOptions, getFunctions } from 'firebase-admin/functions';
import { AddIntroOutroInputType } from './types';
import handleError from '../handleError';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import { getAudioSource, validateAddIntroOutroData } from './utils';
import { emitOperationalAlert } from '../notifications/emitOperationalAlert';

const PROCESS_AUDIO_TARGETS = {
  prod: 'https://process-audio-yshbijirxq-uc.a.run.app/process-audio',
  staging: 'https://process-audio-staging-pvaq33fxyq-uc.a.run.app/process-audio',
  local: 'http://127.0.0.1:8080/process-audio',
};

const getProcessAudioTargetUri = (): string => {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    logger.debug('Running in development mode');
    return PROCESS_AUDIO_TARGETS.local;
  }

  const configuredTarget =
    process.env.PROCESS_AUDIO_TASK_TARGET_URI ||
    process.env.PROCESS_AUDIO_SERVICE_URL ||
    process.env.NEXT_PUBLIC_PROCESS_AUDIO_SERVICE_URL;
  if (configuredTarget) {
    return configuredTarget;
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  if (projectId === 'urm-app-staging') {
    return PROCESS_AUDIO_TARGETS.staging;
  }

  return PROCESS_AUDIO_TARGETS.prod;
};

// let auth: GoogleAuth | undefined;
// /**
//  * Get the URL of a given v2 cloud function.
//  *
//  * @param {string} name the function's name
//  * @param {string} location the function's location
//  * @return {Promise<string>} The URL of the function
//  */
// async function getFunctionUrl(name: string, location = 'us-central1'): Promise<string> {
//   if (!auth) {
//     auth = new GoogleAuth({
//       scopes: 'https://www.googleapis.com/auth/cloud-platform',
//     });
//   }
//   const projectId = await auth.getProjectId();
//   const url =
//     'https://cloudfunctions.googleapis.com/v2beta/' + `projects/${projectId}/locations/${location}/functions/${name}`;

//   const client = await auth.getClient();
//   // eslint-disable-next-line @typescript-eslint/no-explicit-any
//   const res = await client.request<any>({ url });
//   logger.log(res);
//   const uri = res.data?.serviceConfig?.uri as string;
//   if (!uri) {
//     throw new HttpsError('invalid-argument', `Unable to retreive uri for function at ${url}`);
//   }
//   return uri;
// }

const addintrooutrotaskgenerator = onCall(async (request: CallableRequest<AddIntroOutroInputType>): Promise<void> => {
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

  try {
    if (audioSource.type === 'StorageFilePath') {
      // check if the storageFilePath exists
      const [fileExists] = await bucket.file(audioSource.source).exists();
      if (!fileExists) {
        const errorMessage = `${audioSource.source} could not be found`;
        logger.error('Invalid Argument', errorMessage);
        throw new HttpsError('invalid-argument', errorMessage);
      }
    }

    await docRef.update({ 'status.audioStatus': sermonStatusType.PENDING });
    const queue = getFunctions().taskQueue('addintrooutrotaskhandler');
    const targetUri = getProcessAudioTargetUri();
    logger.info('Enqueueing add-intro/outro task', {
      targetUri,
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
    });

    const taskOptions: TaskOptions = {
      dispatchDeadlineSeconds: TIMEOUT_SECONDS,
      uri: targetUri,
    };
    return await queue.enqueue(data, taskOptions);
  } catch (e) {
    logger.error(e);
    try {
      await emitOperationalAlert({
        alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
        summary: 'addintrooutrotaskgenerator failed to enqueue add-intro/outro task.',
        error: e,
        context: {
          functionName: 'addintrooutrotaskgenerator',
          sermonId: data.id,
          audioSourceType: audioSource.type,
          audioSource: audioSource.source,
          taskRoute: 'addintrooutrotaskhandler',
        },
      });
    } catch (alertError) {
      logger.error('Failed to emit operational alert for addintrooutrotaskgenerator', {
        alertError,
        originalError: e,
      });
    }
    throw handleError(e);
  }
});

export default addintrooutrotaskgenerator;
