import { Compute, GoogleAuth } from 'google-auth-library';
import type { FirestoreEvent } from 'firebase-functions/v2/firestore';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { getMosesGuestPilotSelection, PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME, type MosesGuestPilotMarker } from '@upperroom/contracts/processAudioQueue';

const PROJECT = 'urm-app';
const TARGET = 'https://yt-worker.upperroommedia.org/process-audio';
const QUEUE = `projects/${PROJECT}/locations/us-central1/queues/${PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME}`;
const TASKS_URL = `https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`;
const INVOKER = 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com';
const INTENT_HEADER = 'x-urm-moses-pilot-intent';

export const MOSES_PILOT_INTENTS_PATH = 'processAudioMosesGuestPilotIntents';

export type PilotCreateEvent = Pick<FirestoreEvent<unknown>, 'id' | 'project' | 'database' | 'document' | 'source' | 'type'>;

export function isLegacyMosesPilotCreate(args: {
  event: PilotCreateEvent;
  payload: AddIntroOutroInputType;
  originalYoutubeUrl: unknown;
  snapshotPath: string;
  createdAtMs: number;
  targetUri: string;
  projectId?: string;
  databaseURL?: string;
}, env: NodeJS.ProcessEnv = process.env): boolean {
  const { event, payload, createdAtMs } = args;
  const selection = getMosesGuestPilotSelection(env);
  if (!selection || args.targetUri !== TARGET || args.projectId !== PROJECT ||
      !['https://urm-app-default-rtdb.firebaseio.com', 'https://urm-app-default-rtdb.firebaseio.com/'].includes(args.databaseURL ?? '') ||
      env.GCLOUD_PROJECT !== PROJECT || env.NODE_ENV !== 'production' ||
      [env.GOOGLE_CLOUD_PROJECT, env.GOOGLE_CLOUD_QUOTA_PROJECT, env.FIREBASE_PROJECT_ID, env.NEXT_PUBLIC_FIREBASE_PROJECT_ID]
        .some(value => value !== undefined && value !== PROJECT) ||
      env.FUNCTIONS_EMULATOR !== undefined || env.FIRESTORE_EMULATOR_HOST !== undefined ||
      env.FIREBASE_DATABASE_EMULATOR_HOST !== undefined || env.CLOUD_TASKS_EMULATOR_HOST !== undefined) return false;

  const sourceUrl = `https://www.youtube.com/watch?v=${selection.videoId}`;
  return event.project === PROJECT && event.database === '(default)' &&
    event.source === '//firestore.googleapis.com/projects/urm-app/databases/(default)' &&
    event.type === 'google.cloud.firestore.document.v1.created' && /^[A-Za-z0-9_-]{1,128}$/u.test(event.id) &&
    event.document === `sermons/${selection.sermonId}` && args.snapshotPath === event.document &&
    payload.id === selection.sermonId && 'youtubeUrl' in payload && payload.youtubeUrl === sourceUrl &&
    args.originalYoutubeUrl === sourceUrl && !payload.skipTranscode &&
    Number.isFinite(createdAtMs) && createdAtMs >= Date.parse(selection.notBefore) && createdAtMs <= Date.now();
}

export interface PilotSendIntent extends MosesGuestPilotMarker {
  nonce: string;
}

export type PilotTransport = (operation: 'create' | 'inspect', payload: AddIntroOutroInputType, intent: PilotSendIntent) => Promise<void>;

export class PilotTaskNotCreated extends Error {}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const prepareLegacyMosesPilotTransport = async (): Promise<PilotTransport> => {
  const token = await getProviderToken();
  return (operation, data, intent) => sendLegacyMosesPilotTask(operation, data, intent, fetch, async () => token);
};

const getProviderToken = async () => {
  // GoogleAuth.getProjectId() also accepts an environment override. The production
  // sender instead checks the runtime's project and uses its attached identity.
  const project = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(2000),
  });
  if (!project.ok || project.headers.get('metadata-flavor') !== 'Google' || await project.text() !== PROJECT) {
    throw new Error('Unexpected Cloud Tasks runtime project.');
  }
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  if (!(client instanceof Compute)) throw new Error('Cloud Tasks pilot requires the attached Functions identity.');
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Missing Cloud Tasks access token.');
  return token;
};

// Never let a generic client retry a POST. An unknown outcome can only be resolved by
// inspecting this precise task, including its intent nonce, data, target, and OIDC.
export const sendLegacyMosesPilotTask = async (
  operation: 'create' | 'inspect', payload: AddIntroOutroInputType, intent: PilotSendIntent,
  fetchProvider: typeof fetch = fetch, authorize: () => Promise<string> = getProviderToken
): Promise<void> => {
  const taskName = `${QUEUE}/tasks/${intent.taskId}`;
  const headers = { 'Content-Type': 'application/json', [INTENT_HEADER]: intent.nonce };
  const body = Buffer.from(JSON.stringify({ data: payload })).toString('base64');
  const oidcToken = { serviceAccountEmail: INVOKER, audience: TARGET };
  const task = {
    name: taskName,
    dispatchDeadline: '1800s',
    // Give the producer time to record the provider ACK before the first dispatch.
    scheduleTime: new Date(Date.parse(intent.queuedAt) + 30_000).toISOString(),
    httpRequest: { url: TARGET, httpMethod: 'POST', headers, body, oidcToken },
  };
  const token = await authorize();
  let response: Response;
  try {
    response = await fetchProvider(operation === 'create' ? TASKS_URL : `${TASKS_URL}/${intent.taskId}?responseView=FULL`, {
      method: operation === 'create' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(operation === 'create' && { body: JSON.stringify({ task, responseView: 'FULL' }) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const actual = record(await response.json());
      const request = record(actual?.httpRequest);
      const actor = record(request?.oidcToken);
      const actualHeaders = Object.fromEntries(
        Object.entries(record(request?.headers) ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      );
      if (actual?.name === taskName && actual.dispatchDeadline === task.dispatchDeadline &&
          typeof actual.scheduleTime === 'string' && Date.parse(actual.scheduleTime) === Date.parse(task.scheduleTime) &&
          request?.httpMethod === 'POST' && request.url === TARGET && request.body === body &&
          actor?.audience === TARGET && actor.serviceAccountEmail === INVOKER && request.oauthToken === undefined &&
          actualHeaders[INTENT_HEADER] === intent.nonce && actualHeaders['content-type'] === 'application/json' &&
          (actual.dispatchCount ?? 0) === 0 && (actual.responseCount ?? 0) === 0) return;
    }
  } catch {
    throw new Error(`Cloud Tasks pilot ${operation} outcome could not be verified.`);
  }
  if (operation === 'create' && [400, 401, 403, 404].includes(response.status)) {
    throw new PilotTaskNotCreated(`Cloud Tasks rejected the pilot create (HTTP ${response.status}).`);
  }
  throw new Error(`Cloud Tasks pilot ${operation} did not confirm the exact task (HTTP ${response.status}).`);
};
