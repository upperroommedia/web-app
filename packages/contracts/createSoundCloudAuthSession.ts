export type CreateSoundCloudAuthSessionInput = {
  redirectUri: string;
};

export type CreateSoundCloudAuthSessionReturnType = {
  authorizeUrl: string;
  expiresAtMillis: number;
};
