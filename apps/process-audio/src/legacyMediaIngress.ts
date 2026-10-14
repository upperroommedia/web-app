import { OAuth2Client } from 'google-auth-library';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  computeProcessAudioRequestVersion,
  normalizeProcessAudioRequest,
  type StoredProcessAudioRequestState,
} from '@upperroom/contracts/processAudioQueue';

export interface NativeCallerClaims {
  email?: string;
  email_verified?: boolean;
  iss?: string;
  sub?: string;
}
export async function authenticateNativeMediaCaller(
  authorization: unknown,
  config: { audiences: string[]; serviceAccountEmails: string[] },
  verify: (token: string, audience: string[]) => Promise<NativeCallerClaims | undefined> = async (token, audience) =>
    (await new OAuth2Client().verifyIdToken({ idToken: token, audience })).getPayload()
): Promise<void> {
  if (
    !config.audiences.length ||
    !config.serviceAccountEmails.length ||
    config.serviceAccountEmails.some((email) => !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(email))
  )
    throw new Error('Native service caller configuration is missing or malformed.');
  const token = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1] : undefined;
  if (!token) throw new Error('A verified server identity is required.');
  const claims = await verify(token, config.audiences);
  if (
    !claims ||
    !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss ?? '') ||
    claims.email_verified !== true ||
    !claims.sub ||
    !claims.email ||
    !config.serviceAccountEmails.includes(claims.email)
  )
    throw new Error('This service identity is not an authorized media caller.');
}

/** Task headers are binding inputs only after independent OIDC verification. */
export function assertBoundNativeMediaTask(
  payload: AddIntroOutroInputType,
  taskId: string | null,
  state: StoredProcessAudioRequestState | null
): void {
  const version = computeProcessAudioRequestVersion(payload);
  if (
    !taskId ||
    !/^[A-Za-z0-9_-]{1,500}$/.test(taskId) ||
    !state ||
    state.sermonId !== payload.id ||
    state.queuedTaskId !== taskId ||
    state.currentRequestVersion !== version ||
    !state.currentPayload ||
    JSON.stringify(normalizeProcessAudioRequest(state.currentPayload)) !==
      JSON.stringify(normalizeProcessAudioRequest(payload))
  )
    throw new Error('This task does not match an admitted media request.');
}
export function nativeCallerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const parse = (name: string): string[] => {
    const value = env[name];
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item))
      throw new Error(`${name} must be a nonempty string array.`);
    return parsed;
  };
  return {
    audiences: parse('PROCESS_AUDIO_OIDC_AUDIENCES'),
    serviceAccountEmails: parse('PROCESS_AUDIO_ALLOWED_CALLER_EMAILS'),
  };
}
