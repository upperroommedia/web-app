// Utils file for subsplash functions

import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';

export const authenticateSubsplash = async (): Promise<string> => {
  console.log('authenticating subsplash');
  const formData = new FormData();
  if (!process.env.SUBSPLASH_EMAIL || !process.env.SUBSPLASH_PASSWORD) {
    throw new Error('Missing SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD in environment.');
  }
  formData.append('grant_type', 'password');
  formData.append('scope', 'app:9XTSHD');
  formData.append('email', process.env.SUBSPLASH_EMAIL);
  formData.append('password', process.env.SUBSPLASH_PASSWORD);
  const config: AxiosRequestConfig = {
    method: 'post',
    url: 'https://core.subsplash.com/accounts/v1/oauth/token',
    headers: {
      ...formData.getHeaders(),
    },
    data: formData,
  };
  return (await axios(config)).data.access_token;
};
type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type Headers = {
  'Content-Type'?: string;
  Authority?: string;
  Authorization: string;
  Origin?: string;
  'Accept-Encoding'?: string;
  'Accept-Language'?: string;
  'Cache-Control'?: string;
  Referer?: string;
};
export const createAxiosConfig = (
  endpoint_url: string,
  bearerToken: string,
  method: HTTPMethod,
  data?: unknown,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  additionalHeaders?: any
): AxiosRequestConfig => {
  const headers: Headers = {
    'Cache-Control': 'no-cache',
    Authority: 'core.subsplash.com',
    Origin: 'https://dashboard.subsplash.com',
    Referer: 'https://dashboard.subsplash.com/',
    Authorization: `Bearer ${bearerToken}`,
    ...additionalHeaders,
  };
  if (data) {
    headers['Content-Type'] = 'application/vnd.api+json';
  }
  return {
    method: method,
    url: endpoint_url,
    headers: headers,
    data,
  };
};
