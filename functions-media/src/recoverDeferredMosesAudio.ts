import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { onRequest } from 'firebase-functions/v2/https';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { getMosesRecoverySelection } from '@upperroom/contracts/mosesDeferredRecovery';
import { PROCESS_AUDIO_FILE_TASK_QUEUE_NAME, PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME } from '@upperroom/contracts/processAudioQueue';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getProviderToken, sendLegacyMosesPilotTask } from './legacyMosesGuestPilot';
import { recoverDeferredMosesRequest } from './mosesDeferredRecovery';

const AUDIENCE = 'https://us-central1-urm-app.cloudfunctions.net/recoverdeferredmosesaudio';
const OPERATOR = 'moses-recovery-operator@urm-app.iam.gserviceaccount.com';
const oidc = new OAuth2Client({ transporterOptions: { timeout: 3000, retryConfig: { retry: 0 } } });
const metadataBase = 'http://metadata.google.internal/computeMetadata/v1';
const queueBase = 'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues';

export async function verifyMosesRecoveryOperator(
  values: readonly string[] | undefined, subject: string | undefined,
  verify: (jwt: string) => Promise<TokenPayload | undefined> = async jwt => (await oidc.verifyIdToken({ idToken: jwt, audience: AUDIENCE })).getPayload()
): Promise<boolean> {
  if (!subject || !/^[1-9][0-9]{20}$/u.test(subject) || values?.length !== 1 || values[0].length > 8192 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(values[0])) return false;
  try {
    const claim = await verify(values[0].slice(7));
    const now = Math.floor(Date.now() / 1000);
    return !!claim && claim.iss === 'https://accounts.google.com' && claim.aud === AUDIENCE &&
      claim.sub === subject && claim.email === OPERATOR && claim.email_verified === true &&
      Number.isSafeInteger(claim.iat) && claim.iat > 0 && claim.iat <= now && Number.isSafeInteger(claim.exp) && claim.exp > now;
  } catch { return false; }
}

async function verifyRuntime(): Promise<string> {
  const env = process.env;
  const producer = env.PROCESS_AUDIO_MOSES_RECOVERY_PRODUCER_EMAIL;
  const { projectId, databaseURL, storageBucket } = firebaseAdmin.app().options;
  if (!producer || !/^(?:[a-z][a-z0-9-]+@urm-app\.iam\.gserviceaccount\.com|[1-9][0-9]+-compute@developer\.gserviceaccount\.com)$/u.test(producer) ||
      projectId !== 'urm-app' || storageBucket !== 'urm-app.appspot.com' ||
      !['https://urm-app-default-rtdb.firebaseio.com', 'https://urm-app-default-rtdb.firebaseio.com/'].includes(databaseURL ?? '') ||
      env.NODE_ENV !== 'production' || env.GCLOUD_PROJECT !== 'urm-app' ||
      [env.GOOGLE_CLOUD_PROJECT, env.GOOGLE_CLOUD_QUOTA_PROJECT, env.FIREBASE_PROJECT_ID].some(id => id !== undefined && id !== 'urm-app') ||
      Object.keys(env).some(key => key === 'FUNCTIONS_EMULATOR' || key.endsWith('_EMULATOR_HOST'))) throw new Error('Unexpected recovery runtime.');
  const identity = await fetch(`${metadataBase}/instance/service-accounts/default/email`, {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(2000),
  });
  if (!identity.ok || identity.headers.get('metadata-flavor') !== 'Google' || await identity.text() !== producer) {
    throw new Error('Unexpected attached identity.');
  }
  return getProviderToken();
}

// A list response is usable only when every page is fully decoded. A listed same-sermon
// task is an incumbent unless its own previously attempted name will be verified by FULL GET.
export async function assertNoCompetingMosesTask(sermonId: string, ownedTaskId: string | undefined, token: string, provider: typeof fetch = fetch) {
  for (const queueName of [PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME, PROCESS_AUDIO_FILE_TASK_QUEUE_NAME]) {
    const resource = `projects/urm-app/locations/us-central1/queues/${queueName}`;
    const queue = await provider(`${queueBase}/${queueName}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    if (!queue.ok) throw new Error('Queue configuration unavailable.');
    const config = await queue.json() as { name?: unknown; state?: unknown; httpTarget?: unknown; appEngineRoutingOverride?: unknown };
    if (config?.name !== resource || (queueName === PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME &&
        (config.state !== 'RUNNING' || config.httpTarget != null || config.appEngineRoutingOverride != null))) {
      throw new Error('Unexpected queue configuration.');
    }
    let page = '';
    const pages = new Set<string>();
    do {
      if (pages.has(page) || pages.size >= 10) throw new Error('Incomplete task inventory.');
      pages.add(page);
      const url = new URL(`${queueBase}/${queueName}/tasks`);
      url.searchParams.set('responseView', 'FULL');
      url.searchParams.set('pageSize', '100');
      if (page) url.searchParams.set('pageToken', page);
      const response = await provider(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Task inventory unavailable.');
      const result = await response.json() as { tasks?: Array<{ name?: string; httpRequest?: { body?: string } }>; nextPageToken?: string };
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.tasks ?? []) ||
          (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) throw new Error('Invalid task inventory.');
      for (const task of result.tasks ?? []) {
        const body = task.httpRequest?.body;
        if (typeof body !== 'string') throw new Error('Unknown task body.');
        const data = JSON.parse(Buffer.from(body, 'base64').toString('utf8'))?.data;
        if (!data || typeof data.id !== 'string') throw new Error('Unknown task owner.');
        if (data.id !== sermonId) continue;
        const ownName = `projects/urm-app/locations/us-central1/queues/${PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME}/tasks/${ownedTaskId}`;
        if (!ownedTaskId || task.name !== ownName) throw new Error('A task already owns this sermon.');
      }
      page = result.nextPageToken ?? '';
    } while (page);
  }
}

async function readNative(payload: AddIntroOutroInputType, ownedTaskId: string | undefined, token: string) {
  const snapshot = await firebaseAdmin.firestore().collection('sermons').doc(payload.id).get();
  const doc = snapshot.data();
  if (!doc || (doc.id != null && doc.id !== payload.id) || !snapshot.createTime || !snapshot.updateTime || !('youtubeUrl' in payload) || doc.youtubeUrl !== payload.youtubeUrl ||
      doc.sourceStartTime !== payload.startTime || doc.trimDurationSeconds !== payload.duration ||
      doc.status?.audioStatus !== 'PENDING' || doc.status?.soundCloud !== 'NOT_UPLOADED' || doc.status?.subsplash !== 'NOT_UPLOADED' ||
      ['subsplashId', 'subsplashAudioUrl', 'soundCloudTrackId', 'soundCloudTrackUrl', 'audioUrl', 'processedAudioUrl',
        'finalAudioUrl', 'canonicalAudioUrl'].some(key => doc[key] != null && doc[key] !== '') || doc.audioSource === 'subsplash') {
    throw new Error('The production document is not eligible.');
  }
  const bucket = firebaseAdmin.storage().bucket();
  const [processed, final] = await Promise.all([
    bucket.file(`processed-sermons/${payload.id}`).exists(), bucket.file(`intro-outro-sermons/${payload.id}`).exists(),
    assertNoCompetingMosesTask(payload.id, ownedTaskId, token),
  ]);
  if (processed[0] || final[0]) throw new Error('An existing output requires reconciliation.');
  const timestamp = (time: { seconds: number; nanoseconds: number }) => `${time.seconds}.${String(time.nanoseconds).padStart(9, '0')}`;
  return { documentCreateTime: timestamp(snapshot.createTime), documentUpdateTime: timestamp(snapshot.updateTime) };
}

const recoverDeferredMosesAudio = onRequest({ invoker: 'private', region: 'us-central1', concurrency: 1, maxInstances: 1, timeoutSeconds: 60 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).end(); return; }
  if (!await verifyMosesRecoveryOperator(req.headersDistinct['x-urm-recovery-authorization'], process.env.PROCESS_AUDIO_MOSES_RECOVERY_OPERATOR_SUBJECT)) {
    res.status(403).end(); return;
  }
  const selection = getMosesRecoverySelection(process.env);
  if (!selection || (req.method === 'POST' && (process.env.PROCESS_AUDIO_MOSES_RECOVERY_ENABLED !== 'true' || !selection.custodySha256))) {
    res.status(412).end(); return;
  }
  if (Object.keys(req.query).length || req.rawBody?.length) { res.status(400).end(); return; }
  try {
    const token = await verifyRuntime();
    const result = await recoverDeferredMosesRequest(req.method === 'POST' ? 'apply' : 'preview', selection, {
      database: firebaseAdmin.database(),
      readNative: (payload, ownedTaskId) => readNative(payload, ownedTaskId, token),
      prepare: async () => (op, data, intent) => sendLegacyMosesPilotTask(op, data, intent, fetch, async () => token, true),
    });
    res.json(result);
  } catch {
    // Provider, Firestore and GCS errors can include tokens, source URLs, or raw task payloads.
    res.status(409).json({ status: 'unsettled', message: 'Read back the original recovery receipt before proceeding.' });
  }
});

export default recoverDeferredMosesAudio;
