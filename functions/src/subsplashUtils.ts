// Utils file for subsplash functions

import axios, { AxiosRequestConfig, isAxiosError } from 'axios';
import FormData from 'form-data';
import * as crypto from 'crypto';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { SignInWithPuppeteerOutputType } from './signInWithPuppeteer';
import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth();
const db = firebaseAdmin.database();

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
export type AccessToken = string;
type TokenResponse = {
  access_token: AccessToken;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: string;
  session_id: string;
};
export type StoredToken = {
  access_token: AccessToken;
  refresh_token: string;
  expires_at: number;
  scope: string;
  user_id: string;
  session_id: string;
};

export function isTokenResponse(response: unknown): response is TokenResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'access_token' in response &&
    'refresh_token' in response &&
    'expires_in' in response &&
    'scope' in response &&
    'user_id' in response &&
    'session_id' in response &&
    typeof (response as TokenResponse).access_token === 'string' &&
    typeof (response as TokenResponse).refresh_token === 'string' &&
    typeof (response as TokenResponse).expires_in === 'number' &&
    typeof (response as TokenResponse).scope === 'string' &&
    typeof (response as TokenResponse).user_id === 'string' &&
    typeof (response as TokenResponse).session_id === 'string'
  );
}
export function createStoredToken(tokenResponse: TokenResponse): StoredToken {
  const storedToken: StoredToken = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: Date.now() / 1000 + tokenResponse.expires_in - 10,
    scope: tokenResponse.scope,
    user_id: tokenResponse.user_id,
    session_id: tokenResponse.session_id,
  };
  return storedToken;
}

function hashString(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Helper function to encrypt data
export function encryptData(data: string, encryption_key: string): string {
  const iv = crypto.randomBytes(16); // Generate a random initialization vector
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryption_key), iv);

  let encrypted = cipher.update(data, 'utf-8', 'hex');
  encrypted += cipher.final('hex');

  // Return the encrypted data along with the IV, encoded in base64
  return `${iv.toString('hex')}:${encrypted}`;
}

// Function to store encrypted tokens in Firebase
export const storeEncryptedTokens = async (
  tokenData: StoredToken,
  email: string,
  encryption_key: string
): Promise<void> => {
  const { access_token, refresh_token, ...rest } = tokenData;

  // Encrypt sensitive fields
  const encryptedAccessToken = encryptData(access_token, encryption_key);
  const encryptedRefreshToken = encryptData(refresh_token, encryption_key);

  const dataToStore = {
    ...rest,
    access_token: encryptedAccessToken,
    refresh_token: encryptedRefreshToken,
  };

  const dbRef = db.ref(`auth/${hashString(email)}`);
  await dbRef.set(dataToStore);

  console.log(`Stored encrypted tokens for user ${email}`);
};

// Helper function to decrypt data
const decryptData = (encryptedData: string, encryption_key: string): string => {
  const [iv, encrypted] = encryptedData.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryption_key), Buffer.from(iv, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
};

// Function to retrieve and decrypt tokens from Firebase
export const retrieveDecryptedTokens = async (
  user_email: string,
  encryption_key: string
): Promise<StoredToken | null> => {
  const dbRef = db.ref(`auth/${hashString(user_email)}`);
  const snapshot = await dbRef.once('value');

  if (!snapshot.exists()) {
    console.log(`No tokens found for user ${user_email}`);
    return null;
  }

  const storedData = snapshot.val();

  const decryptedAccessToken = decryptData(storedData.access_token, encryption_key);
  const decryptedRefreshToken = decryptData(storedData.refresh_token, encryption_key);

  return {
    access_token: decryptedAccessToken,
    refresh_token: decryptedRefreshToken,
    expires_at: storedData.expires_at,
    scope: storedData.scope,
    user_id: storedData.user_id,
    session_id: storedData.session_id,
  };
};

export const authenticateSubsplash = async (): Promise<string> => {
  console.log('authenticating subsplash');
  const formData = new FormData();
  if (!process.env.EMAIL || !process.env.PASSWORD) {
    throw new Error('Missing email or password in .env file');
  }
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

const refreshToken = async (
  currentStoredToken: StoredToken,
  email: string,
  encryption_key: string
): Promise<AccessToken | undefined> => {
  console.log('Using refresh_token');
  const data = new FormData();
  data.append('grant_type', 'refresh_token');
  data.append('scope', currentStoredToken.scope);
  data.append('refresh_token', currentStoredToken.refresh_token);

  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://core.subsplash.com/accounts/v2/oauth/token',
    headers: {
      grant_type: 'password',
      scope: '9XTSHD',
      Cookie: `refresh_token=${currentStoredToken.refresh_token}; session_id=${currentStoredToken.session_id}`,
      ...data.getHeaders(),
    },
    data: data,
  };
  try {
    const response = await axios.request(config);
    if (isTokenResponse(response.data)) {
      const storedToken = createStoredToken(response.data);
      await storeEncryptedTokens(storedToken, email, encryption_key);
      return response.data.access_token;
    } else {
      console.error(`Response is not of type tokenResponse got: ${JSON.stringify(response.data)}`);
      return;
    }
  } catch (error) {
    if (isAxiosError(error)) {
      console.error('Axios error in mfa:', error.response?.data || error.message);
    } else {
      console.error('Unexpected error in mfa:', error);
    }
    return;
  }
};

export const signInWithPuppeteer = async (): Promise<AccessToken> => {
  const name = 'signinwithpuppeteer';
  const url =
    process.env.FUNCTIONS_EMULATOR == 'true'
      ? `http://127.0.0.1:5001/urm-app/us-central1/${name}`
      : `https://${name}-yshbijirxq-uc.a.run.app`;
  try {
    console.info(`request ${url} with target audience ${url}`);
    const client = await auth.getIdTokenClient(url);
    const token = await client.idTokenProvider.fetchIdToken(url);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        data: '',
      }),
    });
    if (!response.ok) {
      console.log(response);
      throw new Error('Network response was not ok');
    }
    const data: SignInWithPuppeteerOutputType = (await response.json()).result; // Wait for the JSON data
    console.log('DATA', data);
    if (data.status === 'error') {
      console.error(data.error);
      throw new Error(data.error);
    }
    return data.data;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

export const authenticateSubsplashV2 = async (): Promise<AccessToken> => {
  if (!process.env.EMAIL || !process.env.PASSWORD || !process.env.ENCRYPTION_KEY) {
    throw new Error('Missing email or password or encryption_key  in .env file');
  }
  if (process.env.ENCRYPTION_KEY.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be of length 32, current length is ${process.env.ENCRYPTION_KEY.length}`);
  }
  const email = process.env.EMAIL;
  const encryption_key = process.env.ENCRYPTION_KEY;
  try {
    // get storedToken
    const currentStoredToken = await retrieveDecryptedTokens(email, encryption_key);
    if (!currentStoredToken) {
      return await signInWithPuppeteer();
    }
    // check if refresh needed
    const currentTimeSeconds = Date.now() / 1000;
    if (currentTimeSeconds < currentStoredToken.expires_at) {
      return currentStoredToken.access_token;
    }
    // try refresh
    const accessToken = await refreshToken(currentStoredToken, email, encryption_key);
    if (accessToken) {
      return accessToken;
    }
    return await signInWithPuppeteer();
  } catch (error) {
    console.error('Error in authenticateSubsplashV2:', error);
    throw error; // Re-throw the error for further handling
  }
};
