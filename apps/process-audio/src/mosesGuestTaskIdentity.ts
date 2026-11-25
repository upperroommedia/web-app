import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { getMosesGuestPilotSelection, PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME } from '@upperroom/contracts/processAudioQueue';
import { computeMosesRecoveryTaskId, getMosesRecoverySelection } from '@upperroom/contracts/mosesDeferredRecovery';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { readMosesGuestAudioConfig } from './mosesGuestAudio';

const PRODUCTION_ORIGIN = 'https://yt-worker.upperroommedia.org';
const TASK_AUDIENCE = PRODUCTION_ORIGIN + '/process-audio';
const TASK_SERVICE_ACCOUNT = 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com';
const INITIAL_TASK_ID = /^pa-[a-f0-9]{8}-[a-f0-9]{16}-[a-f0-9]{8}$/u;
const INTENT_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const YOUTUBE_SOURCE = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/u;
const MAX_AUTHORIZATION_LENGTH = 8192;

type VerifiedClaims = Pick<TokenPayload, 'aud' | 'iss' | 'sub' | 'email' | 'email_verified' | 'iat' | 'exp'>;
type VerifyIdToken = (idToken: string, audience: string) => Promise<VerifiedClaims | undefined>;
const google = new OAuth2Client({ transporterOptions: { timeout: 3000, retryConfig: { retry: 0 } } });
const verifyGoogleToken: VerifyIdToken = async (idToken, audience) =>
  (await google.verifyIdToken({ idToken, audience })).getPayload();

export function isProductionMosesGuestWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' &&
    env.PROCESS_AUDIO_RUNTIME_ENV === 'production' &&
    env.PROCESS_AUDIO_RUNTIME_PROFILE === 'hetzner' &&
    env.PROCESS_AUDIO_RUNTIME_HOST === 'hetzner' &&
    env.FIREBASE_PROJECT_ID === 'urm-app' &&
    env.GOOGLE_CLOUD_PROJECT === 'urm-app' &&
    env.GCLOUD_PROJECT === 'urm-app' &&
    env.FIREBASE_DATABASE_EMULATOR_HOST === undefined &&
    env.FIRESTORE_EMULATOR_HOST === undefined;
}

type DistinctHeaders = Readonly<Record<string, readonly string[] | undefined>>;
function singleHeader(headers: DistinctHeaders, name: string): string | undefined {
  const values = headers[name];
  return values?.length === 1 ? values[0] : undefined;
}

function readToken(authorization: string | undefined): string | undefined {
  if (!authorization || authorization.length > MAX_AUTHORIZATION_LENGTH || !authorization.startsWith('Bearer ')) return;
  const token = authorization.slice(7);
  const parts = token.split('.');
  const canonical = parts.length === 3 && parts.every(part =>
    part.length > 0 && Buffer.from(part, 'base64url').toString('base64url') === part
  );
  return canonical ? token : undefined;
}

async function hasVerifiedTaskIdentity(headers: DistinctHeaders, env: NodeJS.ProcessEnv, verify: VerifyIdToken): Promise<boolean> {
  const token = readToken(singleHeader(headers, 'authorization'));
  const subject = env.PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT;
  if (!token || !subject || !/^[1-9][0-9]{20}$/u.test(subject) ||
      singleHeader(headers, 'x-cloudtasks-queuename') !== PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME ||
      env.PROCESS_AUDIO_PUBLIC_ORIGIN !== PRODUCTION_ORIGIN ||
      env.PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE !== TASK_AUDIENCE ||
      env.PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT !== TASK_SERVICE_ACCOUNT) return false;
  try {
    const claims = await verify(token, TASK_AUDIENCE);
    const now = Math.floor(Date.now() / 1000);
    return claims !== undefined && claims.iss === 'https://accounts.google.com' &&
      claims.aud === TASK_AUDIENCE && claims.sub === subject && claims.email === TASK_SERVICE_ACCOUNT &&
      claims.email_verified === true && Number.isSafeInteger(claims.iat) && claims.iat > 0 && claims.iat <= now &&
      Number.isSafeInteger(claims.exp) && claims.exp > now;
  } catch {
    return false;
  }
}

export interface VerifiedMosesRecoveryDelivery {
  sermonId: string;
  videoId: string;
  requestVersion: string;
  custodySha256: string;
  taskId: string;
  nonce: string;
  payload: AddIntroOutroInputType;
}

export async function verifyMosesRecoveryDelivery(
  body: { data: AddIntroOutroInputType }, headers: DistinctHeaders,
  env: NodeJS.ProcessEnv = process.env, verify: VerifyIdToken = verifyGoogleToken
): Promise<VerifiedMosesRecoveryDelivery | undefined> {
  const selected = getMosesRecoverySelection(env);
  if (!isProductionMosesGuestWorker(env) || env.PROCESS_AUDIO_MOSES_RECOVERY_ENABLED !== 'true' ||
      !selected?.custodySha256 || !readMosesGuestAudioConfig(env)?.videoIds?.has(selected.videoId)) return;
  const { sermonId, videoId, requestVersion, custodySha256 } = selected;
  const payload = body.data;
  const taskId = computeMosesRecoveryTaskId(sermonId, requestVersion, custodySha256);
  const nonce = singleHeader(headers, 'x-urm-moses-pilot-intent');
  const count = /^(?:0|[1-9][0-9]{0,9})$/u;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'data') || !payload || payload.id !== sermonId ||
      !('youtubeUrl' in payload) || 'storageFilePath' in payload || payload.skipTranscode ||
      payload.youtubeUrl !== `https://www.youtube.com/watch?v=${videoId}` ||
      singleHeader(headers, 'x-cloudtasks-taskname') !== taskId || !nonce || !INTENT_NONCE.test(nonce) ||
      !count.test(singleHeader(headers, 'x-cloudtasks-taskretrycount') ?? '') ||
      !count.test(singleHeader(headers, 'x-cloudtasks-taskexecutioncount') ?? '') ||
      !(await hasVerifiedTaskIdentity(headers, env, verify))) return;
  return { sermonId, videoId, requestVersion, custodySha256, taskId, nonce, payload };
}

export async function readVerifiedMosesPilotIntentNonce(
  source: { id: string; type: string; source: string },
  headers: DistinctHeaders,
  env: NodeJS.ProcessEnv = process.env,
  verify: VerifyIdToken = verifyGoogleToken
): Promise<string | undefined> {
  if (env.MOSES_GUEST_AUDIO_ENABLED !== 'true' || source.type !== 'YouTubeUrl' || !isProductionMosesGuestWorker(env)) {
    return undefined;
  }
  const taskId = singleHeader(headers, 'x-cloudtasks-taskname');
  const intentNonce = singleHeader(headers, 'x-urm-moses-pilot-intent');
  const selection = getMosesGuestPilotSelection(env);
  if (
    !taskId || taskId.length !== 37 || !INITIAL_TASK_ID.test(taskId) ||
    !intentNonce || intentNonce.length !== 36 || !INTENT_NONCE.test(intentNonce) ||
    !selection || source.id !== selection.sermonId || Date.now() < Date.parse(selection.notBefore) ||
    singleHeader(headers, 'x-cloudtasks-queuename') !== PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME ||
    singleHeader(headers, 'x-cloudtasks-taskretrycount') !== '0' ||
    singleHeader(headers, 'x-cloudtasks-taskexecutioncount') !== '0'
  ) return undefined;

  const videoId = YOUTUBE_SOURCE.exec(source.source)?.[1];
  if (videoId !== selection.videoId) return undefined;
  if (!readMosesGuestAudioConfig(env)?.videoIds?.has(videoId)) return undefined;
  return await hasVerifiedTaskIdentity(headers, env, verify) ? intentNonce : undefined;
}
