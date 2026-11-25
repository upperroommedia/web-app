const mockCookieEnqueue = jest.fn(async (_data: unknown, _args: unknown) => undefined);
jest.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue: () => ({ enqueue: mockCookieEnqueue, delete: jest.fn() }) }),
}));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { computeProcessAudioRequestVersion, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import { computeMosesRecoveryTaskId, getMosesRecoverySelection, mosesRecoveryDigest } from '@upperroom/contracts/mosesDeferredRecovery';
import { recoverDeferredMosesRequest } from '../../../../functions-media/src/mosesDeferredRecovery';
import { assertNoCompetingMosesTask, verifyMosesRecoveryOperator } from '../../../../functions-media/src/recoverDeferredMosesAudio';
import { PilotTaskNotCreated, type PilotTransport } from '../../../../functions-media/src/legacyMosesGuestPilot';
import { beginYouTubeQueueProbe, queueOrReplaceProcessAudioRequest } from '../../../../functions-media/src/processAudioQueueStore';

const sermonId = 'recovery-canary-test';
const videoId = 'abcdefghijk';
const payload = sanitizeProcessAudioPayload({ id: sermonId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`, startTime: 12, duration: 16 });
const version = computeProcessAudioRequestVersion(payload);
const selection = { sermonId, videoId, requestVersion: version };
const deferredAt = '2026-11-20T01:02:03.000Z';
const request = { sermonId, sourceType: 'youtube', currentRequestVersion: version, currentPayload: payload, deferredAt, authenticatedDeferralAttemptCount: 1 };
const entry = {
  sermonId, payload, requestVersion: version, deferredAt, lastFailureClass: 'cookie_session_stale_or_challenged',
  disposition: 'WAITING_FOR_YOUTUBE_AUTH', dependencyScope: 'authenticated_session', probeMode: 'cookie_provider',
  dispatchGeneration: 0, blockerEpisodeId: 'episode-one', attemptCount: 1,
};
const state = { probeStatus: 'waiting_for_auth_required_request', deferredYouTubeTaskCount: 2, blockerEpisodeId: 'episode-one' };
const queuePath = 'processAudioQueues/youtube';
const database = firebaseAdmin.database();
const queue = database.ref(queuePath);
const req = database.ref(`processAudioRequests/${sermonId}`);
const receipt = queue.child(`mosesRecoveries/${sermonId}/${version}`);
const deferred = queue.child(`deferred/${sermonId}`);
const otherPayload = { ...payload, id: 'other-request' };
const other = { ...entry, sermonId: otherPayload.id, payload: otherPayload, requestVersion: computeProcessAudioRequestVersion(otherPayload) };
const document = { documentCreateTime: '100.000000000', documentUpdateTime: '101.000000001' };
const provider = jest.fn<ReturnType<PilotTransport>, Parameters<PilotTransport>>();
const deps = { database, readNative: jest.fn(async () => document), prepare: async () => provider };
const preview = () => recoverDeferredMosesRequest('preview', selection, deps);
const apply = (custodySha256: string) => recoverDeferredMosesRequest('apply', { ...selection, custodySha256 }, deps);

describe('one original deferred request through Moses', () => {
  beforeEach(async () => {
    mockCookieEnqueue.mockClear();
    provider.mockReset().mockResolvedValue(undefined);
    deps.readNative.mockReset().mockResolvedValue(document);
    await Promise.all([queue.set({ state, deferred: { [sermonId]: entry, [other.sermonId]: other } }), req.set(request)]);
  });

  it('previews read-only, binds both native rows and exact document times, and emits only one independently authenticated task', async () => {
    const before = (await queue.get()).val();
    const { custodySha256, taskId } = await preview();
    expect((await queue.get()).val()).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
    expect(taskId).toBe(computeMosesRecoveryTaskId(sermonId, version, custodySha256));
    provider.mockImplementationOnce(async (op, body, intent) => {
      expect(op).toBe('create');
      expect(body).toEqual(payload);
      const saved = (await receipt.get()).val();
      expect(saved).toMatchObject({
        ...selection, ...document, requestSha256: mosesRecoveryDigest(request), deferredSha256: mosesRecoveryDigest(entry),
        phase: 'sending', nonce: intent.nonce, custodySha256, taskId,
      });
      expect((await deferred.get()).val()).toEqual({ ...entry,
        mosesRecoveryReservation: { nonce: intent.nonce, requestVersion: version, custodySha256, taskId } });
    });
    await Promise.all([apply(custodySha256), apply(custodySha256)]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await receipt.get()).val().phase).toBe('acknowledged');
    expect((await req.get()).val()).toEqual(request);
    expect((await queue.child('state').get()).val()).toEqual(state);
    expect((await queue.child(`deferred/${other.sermonId}`).get()).val()).toEqual(other);
  });

  it('reconciles unknown outcomes only with the identical request, nonce, name and provider GET', async () => {
    const { custodySha256 } = await preview();
    provider.mockRejectedValueOnce(new Error('network timeout')).mockRejectedValueOnce(new Error('HTTP 404'));
    await expect(apply(custodySha256)).rejects.toThrow('unknown');
    await expect(apply(custodySha256)).rejects.toThrow('404');
    expect((await receipt.get()).val().phase).toBe('sending');
    expect((await deferred.child('mosesRecoveryReservation').get()).exists()).toBe(true);
    await queue.child('state').update({ probeStatus: 'probing', probeTaskSermonId: other.sermonId, probeDispatchReservationId: 'unrelated' });
    await apply(custodySha256);
    expect((await queue.child('state/probeDispatchReservationId').get()).val()).toBe('unrelated');
    expect(provider.mock.calls.map(([op]) => op)).toEqual(['create', 'inspect', 'inspect']);
    expect(provider.mock.calls[0].slice(1)).toEqual(provider.mock.calls[2].slice(1));
  });

  it('restores the exact prior deferral on definite provider rejection and permanently records the result', async () => {
    const { custodySha256 } = await preview();
    provider.mockRejectedValueOnce(new PilotTaskNotCreated('denied'));
    await expect(apply(custodySha256)).resolves.toMatchObject({ phase: 'rejected' });
    await apply(custodySha256);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await deferred.get()).val()).toEqual(entry);
    expect((await queue.child('state').get()).val()).toEqual(state);
  });

  it('withholds custody on drift, successful output, conflicting work and an active cookie probe', async () => {
    const { custodySha256 } = await preview();
    await expect(apply('0'.repeat(64))).rejects.toThrow();
    await req.update({ nextRequestVersion: 'other' });
    await expect(apply(custodySha256)).rejects.toThrow();
    await req.set(request);
    await queue.child('state/probeDispatchReservationId').set('native-probe');
    await expect(apply(custodySha256)).rejects.toThrow();
    await queue.child('state').set(state);
    deps.readNative.mockRejectedValueOnce(new Error('output exists')).mockResolvedValueOnce({ ...document, documentUpdateTime: '102.000000000' });
    await expect(apply(custodySha256)).rejects.toThrow();
    await expect(apply(custodySha256)).rejects.toThrow();
    await deferred.update({ attemptCount: 2 });
    await expect(apply(custodySha256)).rejects.toThrow();
    expect((await receipt.get()).exists()).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it('lets a cookie update select another request while the canary stays reserved', async () => {
    const { custodySha256 } = await preview();
    await apply(custodySha256);
    const reserved = (await deferred.get()).val();
    await beginYouTubeQueueProbe({ database, ownerId: 'test-cookie-update', targetUri: 'https://example.invalid', probeMode: 'cookie_provider' });
    expect(mockCookieEnqueue).toHaveBeenCalledTimes(1);
    expect(mockCookieEnqueue.mock.calls[0][0]).toEqual(otherPayload);
    expect((await deferred.get()).val()).toEqual(reserved);
    expect((await queue.child('state/probeTaskSermonId').get()).val()).toBe(other.sermonId);
    await database.ref(`processAudioRequests/${other.sermonId}`).remove();
  });

  it('protects the reserved original from an unrelated callable replacing or deleting it', async () => {
    const { custodySha256 } = await preview();
    await apply(custodySha256);
    const enqueue = (duration: number) => queueOrReplaceProcessAudioRequest({
      database, payload: { ...payload, duration }, targetUri: 'https://example.invalid', ownerId: 'native-callback',
    });
    await expect(enqueue(payload.duration)).resolves.toMatchObject({ action: 'unchanged' });
    await expect(enqueue(payload.duration + 1)).rejects.toThrow('owns');
    expect((await deferred.child('mosesRecoveryReservation').get()).exists()).toBe(true);
    expect((await req.get()).val()).toEqual(request);
  });
});

describe('private recovery surface', () => {
  it('requires the specific verified operator and explicit, well-formed selection', async () => {
    const subject = '123456789012345678901';
    const audience = 'https://us-central1-urm-app.cloudfunctions.net/recoverdeferredmosesaudio';
    const now = Math.floor(Date.now() / 1000);
    const claim = { iss: 'https://accounts.google.com', aud: audience, sub: subject, email: 'moses-recovery-operator@urm-app.iam.gserviceaccount.com',
      email_verified: true, iat: now - 15, exp: now + 15 };
    expect(await verifyMosesRecoveryOperator(['Bearer one.two.three'], subject, async () => claim)).toBe(true);
    for (const change of [{ sub: 'other' }, { email: 'other@example.org' }, { aud: 'other' }, { exp: now }, { email_verified: false }]) {
      expect(await verifyMosesRecoveryOperator(['Bearer one.two.three'], subject, async () => ({ ...claim, ...change }))).toBe(false);
    }
    expect(getMosesRecoverySelection({})).toBeNull();
    expect(getMosesRecoverySelection({ PROCESS_AUDIO_MOSES_RECOVERY_SERMON_ID: sermonId, PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION: version,
      PROCESS_AUDIO_MOSES_RECOVERY_VIDEO_ID: videoId, PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256: 'invalid' })).toBeNull();
  });

  it('checks both real queue inventories and refuses unknown owners or a queue-level destination override', async () => {
    const task = (id: string) => ({ name: 'unrelated-task', httpRequest: { body: Buffer.from(JSON.stringify({ data: { id } })).toString('base64') } });
    const queueConfig = (queueName: string) => ({ name: `projects/urm-app/locations/us-central1/queues/${queueName}`, state: 'RUNNING' });
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const next = (...items: unknown[]) => items.forEach(item => fetcher.mockResolvedValueOnce(Response.json(item)));
    next(queueConfig('processaudioyoutubetask'), { tasks: [task('another')], nextPageToken: 'second-page' },
      {}, queueConfig('processaudiofiletask'), { tasks: [task(sermonId)] });
    await expect(assertNoCompetingMosesTask(sermonId, undefined, 'test', fetcher)).rejects.toThrow('owns');
    next({ ...queueConfig('processaudioyoutubetask'), httpTarget: { uriOverride: {} } });
    await expect(assertNoCompetingMosesTask(sermonId, undefined, 'test', fetcher)).rejects.toThrow('configuration');
    next(queueConfig('processaudioyoutubetask'), { tasks: [{}] });
    await expect(assertNoCompetingMosesTask(sermonId, undefined, 'test', fetcher)).rejects.toThrow('body');
  });
});
