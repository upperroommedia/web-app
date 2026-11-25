import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { onRequest } from 'firebase-functions/v2/https';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  getMosesRecoveryCohort, getMosesRecoverySelection, MOSES_BACKLOG_FENCES_PATH, MOSES_RECOVERY_RECEIPTS_PATH,
  computeMosesBacklogCustody, computeMosesBacklogTaskId, computeMosesRecoveryCustody, computeMosesRecoveryTaskId,
  type MosesRecoveryCohortMember, type MosesRecoverySelection,
} from '@upperroom/contracts/mosesDeferredRecovery';
import type { Database } from 'firebase-admin/database';
import { PROCESS_AUDIO_FILE_TASK_QUEUE_NAME, PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME } from '@upperroom/contracts/processAudioQueue';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getProviderToken, sendLegacyMosesPilotTask } from './legacyMosesGuestPilot';
import { recoverDeferredMosesRequest } from './mosesDeferredRecovery';
import { getMosesBacklogSelection, recoverMosesBacklogRequest, type BacklogSelection, type MosesBacklogDependencies } from './mosesBacklogRecovery';
import { readMosesBacklogNativeHead, readNativeBacklogWitness, verifyNativeBacklogDocumentFence } from './mosesBacklogNative';
import type { PilotTransport } from './legacyMosesGuestPilot';

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

type Route = {
  backlog?: BacklogSelection;
  deferred?: MosesRecoverySelection;
  peers?: MosesRecoveryCohortMember[];
};

export function getMosesRecoveryRoute(env: NodeJS.ProcessEnv, post: boolean, query: Record<string, unknown>,
  headers: Readonly<Record<string, readonly string[] | undefined>>): Route | null {
  const custody = headers['x-urm-recovery-custody'];
  const generation = headers['x-urm-recovery-witness-generation'];
  if (post && env.PROCESS_AUDIO_MOSES_RECOVERY_ENABLED !== 'true') return null;
  if (env.PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL === undefined) {
    if (Object.keys(query).length || custody !== undefined || generation !== undefined) return null;
    const kind = env.PROCESS_AUDIO_MOSES_RECOVERY_KIND;
    const backlog = getMosesBacklogSelection(env);
    if (backlog) return !post || (backlog.requestVersion && backlog.custodySha256) ? { backlog } : null;
    const deferred = getMosesRecoverySelection(env);
    return deferred && (kind === undefined || kind === 'deferred_cookie') && (!post || deferred.custodySha256) ? { deferred } : null;
  }
  const rows = getMosesRecoveryCohort(env);
  if (!rows || Object.keys(query).length !== 1 || typeof query.ref !== 'string') return null;
  const member = rows.find(row => row.ref === query.ref);
  if (!member || (post ? custody?.length !== 1 || !/^[0-9a-f]{64}$/u.test(custody[0]) : custody !== undefined) ||
      (generation !== undefined && (!post || member.kind === 'deferred_cookie' || generation.length !== 1 ||
        !/^[1-9][0-9]*$/u.test(generation[0]) || !Number.isSafeInteger(Number(generation[0]))))) return null;
  const peers = rows.filter(row => row.ref !== member.ref);
  const { kind, sermonId, videoId, requestVersion } = member;
  const selection = { sermonId, videoId, requestVersion, ...(custody && { custodySha256: custody[0] }) };
  if (kind === 'deferred_cookie') return requestVersion ? { deferred: { ...selection, requestVersion }, peers } : null;
  const releaseSha = env.PROCESS_AUDIO_MOSES_BACKLOG_RELEASE_SHA;
  return releaseSha && /^[0-9a-f]{40}$/u.test(releaseSha) ?
    { backlog: { ...selection, kind, releaseSha, ...(kind === 'missing_admission' && !requestVersion && { deriveCohortMissingVersion: true as const }),
        ...(generation && { witnessGeneration: generation[0] }) }, peers } : null;
}

// The caller already owns the same global RTDB recovery claim used by both producers.
// Every other selected original must be unstarted, definitely rejected, or natively completed.
export async function assertOtherCohortRowsIdle(database: Database, peers: MosesRecoveryCohortMember[]) {
  await Promise.all(peers.map(async member => {
    const path = member.kind === 'deferred_cookie' ?
      MOSES_RECOVERY_RECEIPTS_PATH + '/' + member.sermonId + '/' + member.requestVersion :
      MOSES_BACKLOG_FENCES_PATH + '/' + member.sermonId;
    const state = (await database.ref(path).get()).val();
    if (state === null) return;
    const completed = state.phase === 'consumed' && state.outcome === 'completed' && typeof state.owner === 'string' && !!state.owner &&
      /^[0-9a-f]{64}$/u.test(state.completedRequestSha256) && /^\d+\.\d{9}$/u.test(state.proof?.documentWriteTime) &&
      Number.isFinite(Date.parse(state.proof?.completedAt)) && typeof state.proof?.mosesVerified === 'boolean' &&
      ['public_provider', 'cookie_provider', 'browser_fallback'].includes(state.proof?.authority);
    if ((completed || state.phase === 'rejected') && state.kind === member.kind && state.sermonId === member.sermonId &&
        state.videoId === member.videoId && /^[0-9a-f]{16}$/u.test(state.requestVersion) &&
        (!member.requestVersion || state.requestVersion === member.requestVersion)) {
      const kind = member.kind;
      const deferred = kind === 'deferred_cookie';
      const digest = deferred ? computeMosesRecoveryCustody(state) : computeMosesBacklogCustody(state);
      const id = deferred ? computeMosesRecoveryTaskId(member.sermonId, state.requestVersion, digest) :
        computeMosesBacklogTaskId(kind, member.sermonId, state.requestVersion, digest);
      if (state.schema === (deferred ? 1 : 2) && state.custodySha256 === digest && state.taskId === id) return;
    }
    throw new Error('A different cohort row remains unsettled.');
  }));
}

const recoverDeferredMosesAudio = onRequest({ invoker: 'private', region: 'us-central1', concurrency: 1, maxInstances: 1, timeoutSeconds: 60 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).end(); return; }
  if (!await verifyMosesRecoveryOperator(req.headersDistinct['x-urm-recovery-authorization'], process.env.PROCESS_AUDIO_MOSES_RECOVERY_OPERATOR_SUBJECT)) {
    res.status(403).end(); return;
  }
  if (req.rawBody?.length) { res.status(400).end(); return; }
  // Keep the original single-row API's malformed-query disposition.
  if (process.env.PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL === undefined && Object.keys(req.query).length) { res.status(400).end(); return; }
  const route = getMosesRecoveryRoute(process.env, req.method === 'POST', req.query, req.headersDistinct);
  if (!route) { res.status(412).end(); return; }
  try {
    const token = await verifyRuntime();
    const mode = req.method === 'POST' ? 'apply' : 'preview';
    const database = firebaseAdmin.database();
    const prepare = async (): Promise<PilotTransport> => (op, data, intent) => sendLegacyMosesPilotTask(op, data, intent, fetch, async () => token, true);
    const assertCohortIdle = route.peers && (() => assertOtherCohortRowsIdle(database, route.peers!));
    if (route.backlog) {
      const backlog = route.backlog;
      const deps: MosesBacklogDependencies = {
        database, prepare, assertCohortIdle, verifyDocumentFence: verifyNativeBacklogDocumentFence,
        readWitness: fence => readNativeBacklogWitness(fence, backlog.witnessGeneration),
        readHead: (selected, original, previous, own) => readMosesBacklogNativeHead(selected, original, previous, own, token, assertNoCompetingMosesTask),
      };
      res.json(await recoverMosesBacklogRequest(mode, backlog, deps));
      return;
    }
    if (!route.deferred) { res.status(412).end(); return; }
    const result = await recoverDeferredMosesRequest(mode, route.deferred, {
      database, prepare, assertCohortIdle, readNative: (payload, ownedTaskId) => readNative(payload, ownedTaskId, token),
    });
    res.json(result);
  } catch {
    // Provider, Firestore and GCS errors can include tokens, source URLs, or raw task payloads.
    res.status(409).json({ status: 'unsettled', message: 'Read back the original recovery receipt before proceeding.' });
  }
});

export default recoverDeferredMosesAudio;
