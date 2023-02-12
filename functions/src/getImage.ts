import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import axios, { AxiosRequestConfig } from 'axios';
export interface GetImageInputType {
  url: string;
}

export interface GetImageOutputType {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
}

const getimage = onCall(async (request: CallableRequest<GetImageInputType>): Promise<GetImageOutputType> => {
  logger.log('getimage', request);
  if (request.auth?.token.role !== 'admin') {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;
  logger.log('URL', data.url);
  const uploadConfig: AxiosRequestConfig = {
    url: data.url,
    method: 'GET',
    responseType: 'arraybuffer',
  };
  try {
    logger.log('uploadConfig', uploadConfig);
    const axiosResponse = await axios(uploadConfig);
    // logger.log('axiosResponse', axiosResponse);
    const headers = axiosResponse.headers;
    logger.log('headers', headers);
    const blobType = headers['content-type'];
    logger.log('blobType', blobType);
    const imageBuffer = Buffer.from(axiosResponse.data).toJSON();
    return { buffer: imageBuffer };
  } catch (error) {
    if (error instanceof HttpsError) {
      logger.error('HttpsError', error);
      throw error;
    }
    if (axios.isAxiosError(error)) {
      logger.error('AxiosError', error);
      throw new HttpsError('internal', error.message, error.name);
    }
    if (error instanceof Error) {
      logger.error('Error', error);
      throw new HttpsError('internal', error.message);
    }
    logger.error('Unknown Error', error);
    throw new HttpsError('internal', 'Unknown error');
  }
});

export default getimage;
