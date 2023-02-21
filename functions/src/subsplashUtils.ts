// Utils file for subsplash functions

import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';

export const authenticateSubsplash = async (): Promise<string> => {
  const formData = new FormData();
  formData.append('grant_type', 'password');
  formData.append('scope', 'app:9XTSHD');
  formData.append('email', process.env.EMAIL);
  formData.append('password', process.env.PASSWORD);

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
