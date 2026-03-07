import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_INVITE_TOKEN_BYTES = 32;

export const createInviteToken = (tokenBytes = DEFAULT_INVITE_TOKEN_BYTES): string =>
  randomBytes(tokenBytes).toString('base64url');

export const hashInviteToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

export const createInviteTokenArtifact = (tokenBytes = DEFAULT_INVITE_TOKEN_BYTES): { rawToken: string; tokenHash: string } => {
  const rawToken = createInviteToken(tokenBytes);
  return {
    rawToken,
    tokenHash: hashInviteToken(rawToken),
  };
};
