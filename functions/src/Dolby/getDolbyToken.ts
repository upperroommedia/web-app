import logger from 'firebase-functions/logger';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import qs from 'qs';

const getDolbyToken = async (): Promise<AxiosResponse> => {
  const data = qs.stringify({
    grant_type: 'client_credentials',
  });

  const keySecret = `${process.env.DOLBY_API_KEY}:${process.env.DOLBY_API_SECRET}`;
  logger.log('Key:Secret', keySecret);
  const creds = Buffer.from(keySecret).toString('base64');

  const config: AxiosRequestConfig = {
    method: 'post',
    url: 'https://api.dolby.io/v1/auth/token',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${creds}`,
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: data,
  };
  logger.log('getDolbyToken axios config', config);

  return await axios(config);
};

export default getDolbyToken;
