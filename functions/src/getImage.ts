import { https, logger } from 'firebase-functions';
import axios, { AxiosRequestConfig } from 'axios';

export interface GetImageInputType {
  url: string;
}

const getImage = https.onCall(async (data: GetImageInputType, context) => {
  if (context.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }
  logger.log('URL', data.url);
  const uploadConfig: AxiosRequestConfig = {
    url: data.url,
    method: 'GET',
  };
  logger.log('Axios config', uploadConfig);
  try {
    logger.log('uploadConfig', uploadConfig);
    return (await axios(uploadConfig)).data;
  } catch (error) {
    logger.error(error);
    let message = 'Unknown Error';
    if (error instanceof Error) message = error.message;
    return message;
  }
});

export default getImage;
