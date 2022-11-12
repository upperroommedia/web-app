import { https, logger } from 'firebase-functions';
import axios, { AxiosRequestConfig } from 'axios';
import { storage } from 'firebase-admin';
import { unlink } from 'fs/promises';
import fs, { existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
export interface SaveImageInputType {
  url: string;
  name: string;
}
const tempFiles = new Set<string>();

const createTempFile = (fileName: string) => {
  try {
    if (!existsSync(os.tmpdir())) {
      mkdirSync(os.tmpdir());
    }
    const filePath = path.join(os.tmpdir(), fileName);
    tempFiles.add(filePath);
    return filePath;
  } catch (err) {
    throw new Error(`Error creating temp file: ${err}`);
  }
};

const saveImage = https.onCall(async (data: SaveImageInputType, context) => {
  if (context.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }
  logger.log('URL', data.url);
  const uploadConfig: AxiosRequestConfig = {
    url: data.url,
    method: 'GET',
    responseType: 'arraybuffer',
  };
  logger.log('Axios config', uploadConfig);
  try {
    logger.log('uploadConfig', uploadConfig);
    const axiosResponse = await axios(uploadConfig);
    // logger.log('axiosResponse', axiosResponse);
    const headers = axiosResponse.headers;
    logger.log('headers', headers);
    const blobType = headers['content-type'];
    logger.log('blobType', blobType);
    const imageBlob = axiosResponse.data;
    logger.log(imageBlob);
    const tempFilePath = createTempFile(data.name);
    logger.log(`Saving image to ${tempFilePath}`);
    fs.writeFileSync(tempFilePath, Buffer.from(imageBlob));
    // Upload your data
    // const bucket = storage().bucket();
    const destinationFilePath = `images/${data.name}`;
    const bucket = storage().bucket('urm-images');
    await bucket.upload(tempFilePath, {
      destination: destinationFilePath,
    });
    await bucket.file(destinationFilePath).setMetadata({ contentType: blobType });
    // Delete the temporary file (crucial)
    return { status: 'success' };
  } catch (error) {
    logger.error(error);
    let message = 'Unknown Error';
    if (error instanceof Error) message = error.message;
    return message;
  } finally {
    const promises: Promise<void>[] = [];
    tempFiles.forEach((file) => {
      logger.log('Deleting temp file', file);
      promises.push(unlink(file));
    });
    await Promise.all(promises);
    logger.log('Temp files deleted');
  }
});

export default saveImage;
