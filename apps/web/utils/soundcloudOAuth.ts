const SOUND_CLOUD_OAUTH_STORAGE_KEY = 'soundcloud.oauth.pending';

export type PendingSoundCloudOAuth = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAtMillis: number;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const randomString = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export const createPkcePair = async (): Promise<{ codeVerifier: string; codeChallenge: string }> => {
  const codeVerifier = randomString(64);
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = toBase64Url(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
};

export const createOAuthState = (): string => randomString(32);

export const storePendingSoundCloudOAuth = (value: PendingSoundCloudOAuth): void => {
  window.sessionStorage.setItem(SOUND_CLOUD_OAUTH_STORAGE_KEY, JSON.stringify(value));
};

export const readPendingSoundCloudOAuth = (): PendingSoundCloudOAuth | null => {
  const raw = window.sessionStorage.getItem(SOUND_CLOUD_OAUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PendingSoundCloudOAuth;
    if (!parsed?.state || !parsed?.codeVerifier || !parsed?.redirectUri) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearPendingSoundCloudOAuth = (): void => {
  window.sessionStorage.removeItem(SOUND_CLOUD_OAUTH_STORAGE_KEY);
};
