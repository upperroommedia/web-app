import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import axios, { AxiosRequestConfig } from 'axios';
import handleError from './handleError';
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
    logger.error('getImage failed', error);
    throw handleError(error, {
      alertCode: 'GET_IMAGE_RUNTIME_FAILURE',
      summary: 'getImage failed while fetching a remote image.',
      context: { functionName: 'getImage', url: data.url },
    });
  }
});

export default getimage;
