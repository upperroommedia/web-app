import { https, logger } from 'firebase-functions';
import axios, { AxiosRequestConfig } from 'axios';
export interface GetImageInputType {
  url: string;
}

export interface GetImageOutputType {
  status: 'success' | 'error';
  message?: string;
  buffer?: {
    type: 'Buffer';
    data: number[];
  };
}

const getimage = https.onCall(async (data: GetImageInputType, context): Promise<GetImageOutputType> => {
  if (context.auth?.token.role !== 'admin') {
    return { status: 'error', message: 'Not Authorized' };
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
    const imageBuffer = Buffer.from(axiosResponse.data).toJSON();
    return { status: 'success', buffer: imageBuffer };
  } catch (error) {
    logger.error(error);
    let message = 'Unknown Error';
    if (error instanceof Error) message = error.message;
    return { message, status: 'error' };
  }
});

export default getimage;
