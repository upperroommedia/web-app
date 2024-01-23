import '../mockCloudTasks';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { GoogleAuth } from 'google-auth-library';
import { TaskOptions, getFunctions } from 'firebase-admin/functions';
import { AddIntroOutroInputType } from './types';
import handleError from '../handleError';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import path from 'path';
import { sermonStatusType } from '../../../types/SermonTypes';

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
  if (
    !data.storageFilePath ||
    data.startTime === undefined ||
    data.startTime === null ||
    data.duration === null ||
    data.duration === undefined
  ) {
    const errorMessage =
      'Data must contain storageFilePath (string), startTime (number), and endTime (number) properties || optionally introUrl (string) and outroUrl (string)';
    logger.error('Invalid Argument', errorMessage);
    throw new HttpsError('invalid-argument', errorMessage);
  }

  const bucket = firebaseAdmin.storage().bucket();
  const db = firebaseAdmin.firestore();

  const fileName = path.basename(data.storageFilePath);
  const docRef = db.collection('sermons').doc(fileName);

  try {
    // check if the storageFilePath exists
    const [fileExists] = await bucket.file(data.storageFilePath).exists();
    if (!fileExists) {
      const errorMessage = `${data.storageFilePath} could not be found`;
      logger.error('Invalid Argument', errorMessage);
      throw new HttpsError('invalid-argument', errorMessage);
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
