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
  if (request.auth?.token.role !== 'admin') {
    throw new HttpsError('failed-precondition', 'The function must be called while authenticated.');
  }
  const data = request.data;
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
    const imageBuffer = Buffer.from(axiosResponse.data).toJSON();
    return { buffer: imageBuffer };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    if (axios.isAxiosError(error)) {
      throw new HttpsError('internal', error.message, error.toJSON());
    }
    if (error instanceof Error) {
      throw new HttpsError('internal', error.message);
    }
    throw new HttpsError('internal', 'Unknown error');
  }
});

export default getimage;
