export type ExchangeSoundCloudAuthorizationCodeResult = {
  connected: true;
  accessTokenExpiresAtMillis: number;
  connectedAtMillis: number;
  connectedByEmail?: string;
};

export type ExchangeSoundCloudAuthCodeInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type ExchangeSoundCloudAuthCodeReturnType = ExchangeSoundCloudAuthorizationCodeResult;
