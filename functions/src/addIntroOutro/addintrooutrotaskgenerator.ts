import '../mockCloudTasks';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { GoogleAuth } from 'google-auth-library';
import { TaskOptions, getFunctions } from 'firebase-admin/functions';
import { AddIntroOutroInputType } from './types';
import handleError from '../handleError';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { sermonStatusType } from '../../../types/SermonTypes';
import { getAudioSource, validateAddIntroOutroData } from './utils';

let auth: GoogleAuth | undefined;
/**
 * Get the URL of a given v2 cloud function.
 *
 * @param {string} name the function's name
 * @param {string} location the function's location
 * @return {Promise<string>} The URL of the function
 */
async function getFunctionUrl(name: string, location = 'us-central1'): Promise<string> {
  if (!auth) {
    auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
  }
  const projectId = await auth.getProjectId();
  const url =
    'https://cloudfunctions.googleapis.com/v2beta/' + `projects/${projectId}/locations/${location}/functions/${name}`;

  const client = await auth.getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await client.request<any>({ url });
  logger.log(res);
  const uri = res.data?.serviceConfig?.uri as string;
  if (!uri) {
    throw new HttpsError('invalid-argument', `Unable to retreive uri for function at ${url}`);
  }
  return uri;
}

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

    let targetUri: string;

    if (process.env.FUNCTIONS_EMULATOR === 'true') {
      logger.debug('Running in development mode');
      targetUri = 'http://127.0.0.1:5001/urm-app/us-central1/addintrooutrotaskhandler';
    } else {
      targetUri = await getFunctionUrl('addintrooutrotaskhandler');
    }

    const taskOptions: TaskOptions = {
      dispatchDeadlineSeconds: TIMEOUT_SECONDS,
      uri: targetUri,
    };
    return await queue.enqueue(data, taskOptions);
  } catch (e) {
    logger.error(e);
    throw handleError(e);
  }
});

export default addintrooutrotaskgenerator;
