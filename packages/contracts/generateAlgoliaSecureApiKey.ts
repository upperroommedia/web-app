// Caller identity is always derived from callable authentication.
export type GenerateSecuredApiKeyInputType = Record<string, never>;

export interface GenerateSecuredApiKeyOutputType {
  apiKey: string;
  sharedApiKey: string;
  expiresAt: number;
  sermonIndices: string[];
  sharedIndices: string[];
}
