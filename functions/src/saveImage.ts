import { logger } from 'firebase-functions/v2';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import axios, { AxiosRequestConfig } from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import handleError from './handleError';
import { getFirebaseImagesBucket } from '@upperroom/shared/shared/firebaseProjectConfig';
import { normalizeHttpContentType } from './helpers/httpResponseHeaders';
export interface SaveImageInputType {
  url: string;
  name: string;
}
const saveImage = onCall(async (request: CallableRequest<SaveImageInputType>) => {
  if (request.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }
  logger.log('URL', request.data.url);
  const uploadConfig: AxiosRequestConfig = {
    url: request.data.url,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 25 * 1024 * 1024,
  };
  logger.log('Axios config', uploadConfig);
  let temporaryDirectory: string | undefined;
  try {
    logger.log('uploadConfig', uploadConfig);
    const axiosResponse = await axios(uploadConfig);
    // logger.log('axiosResponse', axiosResponse);
    const headers = axiosResponse.headers;
    logger.log('headers', headers);
    const blobType = normalizeHttpContentType(headers['content-type']);
    logger.log('blobType', blobType);
    const imageBlob = axiosResponse.data;
    logger.log(imageBlob);
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'urm-save-image-'));
    const tempFilePath = path.join(temporaryDirectory, 'source');
    logger.log(`Saving image to ${tempFilePath}`);
    await writeFile(tempFilePath, Buffer.from(imageBlob));
    // Upload your data
    // const bucket = storage().bucket();
    const destinationFilePath = `speaker-images/${request.data.name}`;
    const bucket = firebaseAdmin.storage().bucket(getFirebaseImagesBucket());
    await bucket.upload(tempFilePath, {
      destination: destinationFilePath,
    });
    if (blobType) {
      await bucket.file(destinationFilePath).setMetadata({ contentType: blobType });
    }
    // Delete the temporary file (crucial)
    return { status: 'success' };
  } catch (error) {
    handleError(error, {
      alertCode: 'SAVE_IMAGE_RUNTIME_FAILURE',
      summary: 'saveImage failed while downloading or uploading an image.',
      request,
      context: { functionName: 'saveImage', url: request.data.url, name: request.data.name },
    });
    return 'Error saving image';
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  }
});

export default saveImage;
