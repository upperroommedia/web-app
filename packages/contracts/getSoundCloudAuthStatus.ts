export type SoundCloudAuthStatus = {
  clientId: string | null;
  callbackPath: string;
  connected: boolean;
  configured: boolean;
  reconnectRequired?: true;
  accountId?: string;
  tokenSource: 'firestore' | 'secret' | 'none';
  accessTokenExpiresAtMillis?: number;
  connectedAtMillis?: number;
  connectedByEmail?: string;
  updatedAtMillis?: number;
};

export type GetSoundCloudAuthStatusInput = { view?: 'publish' };
export type SoundCloudPublishingAuthStatus = Pick<SoundCloudAuthStatus, 'connected' | 'reconnectRequired'>;
export type GetSoundCloudAuthStatusReturnType = SoundCloudAuthStatus;
