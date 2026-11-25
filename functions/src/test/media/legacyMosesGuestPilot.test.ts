const mockOrdinaryEnqueue = jest.fn(async (_payload: unknown, _opts: unknown) => undefined);
jest.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue: () => ({ enqueue: mockOrdinaryEnqueue, delete: jest.fn() }) }),
}));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { computeProcessAudioRequestVersion, computeProcessAudioTaskId, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import { isLegacyMosesPilotCreate, MOSES_PILOT_INTENTS_PATH, PilotTaskNotCreated, sendLegacyMosesPilotTask, type PilotSendIntent, type PilotTransport } from '../../../../functions-media/src/legacyMosesGuestPilot';
import { queueInitialMosesGuestPilot, queueOrReplaceProcessAudioRequest } from '../../../../functions-media/src/processAudioQueueStore';

const sermonId = 'pilot-one';
const videoId = 'abcdefghijk';
const eventId = 'native-create-event-123';
const target = 'https://yt-worker.upperroommedia.org/process-audio';
const payload = { id: sermonId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`, startTime: 1, duration: 5 };
const now = new Date('2026-01-10T12:15:45.000Z');
const selection = {
  GCLOUD_PROJECT: 'urm-app', NODE_ENV: 'production', MOSES_GUEST_AUDIO_ENABLED: 'true',
  MOSES_GUEST_AUDIO_VIDEO_IDS: videoId, PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: sermonId,
  PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: now.toISOString(),
};
const event = {
  id: eventId, project: 'urm-app', database: '(default)', document: `sermons/${sermonId}`,
  type: 'google.cloud.firestore.document.v1.created', source: '//firestore.googleapis.com/projects/urm-app/databases/(default)',
};
const selectionArgs = {
  event, payload, originalYoutubeUrl: payload.youtubeUrl, snapshotPath: event.document, createdAtMs: now.getTime(),
  targetUri: target, projectId: 'urm-app', databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/',
};

describe('Moses pilot producer selection', () => {
  it('accepts only the configured native production create after arming', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime() + 1000);
    try {
      expect(isLegacyMosesPilotCreate(selectionArgs, selection)).toBe(true);
      for (const env of [
        { MOSES_GUEST_AUDIO_ENABLED: undefined }, { GCLOUD_PROJECT: 'urm-app-staging' }, { GOOGLE_CLOUD_PROJECT: 'other' },
        { FUNCTIONS_EMULATOR: 'true' }, { FIREBASE_DATABASE_EMULATOR_HOST: 'localhost' }, { NODE_ENV: 'test' },
        { PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: 'other' }, { MOSES_GUEST_AUDIO_VIDEO_IDS: `${videoId},${videoId}` },
        { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: '2026-01-10T12:15:45Z' },
      ]) expect(isLegacyMosesPilotCreate(selectionArgs, { ...selection, ...env })).toBe(false);
      for (const changes of [
        { event: { ...event, type: 'google.cloud.firestore.document.v1.updated' } }, { event: { ...event, id: '' } },
        { event: { ...event, project: 'urm-app-staging' } }, { event: { ...event, database: 'other' } },
        { event: { ...event, document: 'sermons/other' } }, { snapshotPath: 'sermons/other' },
        { originalYoutubeUrl: ` ${payload.youtubeUrl}` }, { payload: { ...payload, id: 'other' } },
        { payload: { ...payload, youtubeUrl: `${payload.youtubeUrl}&t=30` } }, { createdAtMs: now.getTime() - 1 },
        { createdAtMs: Infinity }, { projectId: 'urm-app-staging' }, { databaseURL: 'https://example.test/' },
        { targetUri: 'https://yt-worker-staging.upperroommedia.org/process-audio' },
      ]) expect(isLegacyMosesPilotCreate({ ...selectionArgs, ...changes }, selection)).toBe(false);
    } finally { jest.restoreAllMocks(); }
  });
});

describe('Moses pilot single-send receipt', () => {
  const database = firebaseAdmin.database();
  const args = { database, eventId, payload, targetUri: target, isCurrentCreate: async () => true, isValidLegacySource: async () => true };
  const req = database.ref(`processAudioRequests/${sermonId}`);
  const receipt = database.ref(`${MOSES_PILOT_INTENTS_PATH}/${sermonId}`);
  const deferred = database.ref(`processAudioQueues/youtube/deferred/${sermonId}`);
  const lock = database.ref(`processAudioLocks/${sermonId}`);
  const provider = jest.fn<ReturnType<PilotTransport>, Parameters<PilotTransport>>();

  const prepare = async () => provider;
  beforeEach(async () => {
    mockOrdinaryEnqueue.mockClear();
    provider.mockReset().mockResolvedValue(undefined);
    await Promise.all([req.remove(), receipt.remove(), deferred.remove(), lock.remove()]);
  });

  it('publishes only an acknowledged original task and sends once through concurrent deliveries', async () => {
    provider.mockImplementationOnce(async (operation, _data, intent) => {
      expect(operation).toBe('create');
      expect((await receipt.get()).val()).toEqual({ ...intent, phase: 'sending' });
      const state = (await req.get()).val();
      expect(state.mosesGuestPilotIntent.eventId).toBe(eventId);
      expect(state.mosesGuestPilot).toBeUndefined();
      expect(state.queuedTaskId).toBeUndefined();
    });
    const results = await Promise.all([queueInitialMosesGuestPilot(args, prepare), queueInitialMosesGuestPilot(args, prepare)]);
    expect(results.map(result => result.action).sort()).toEqual(['queued', 'unchanged']);
    expect(provider).toHaveBeenCalledTimes(1);
    const state = (await req.get()).val();
    const version = computeProcessAudioRequestVersion(payload);
    const taskId = computeProcessAudioTaskId(sermonId, version, `sermon-create:${eventId}:${state.queuedAt}`);
    expect(state.mosesGuestPilot).toEqual({ taskId, eventId, queuedAt: state.queuedAt, requestVersion: version });
    expect(state.queuedTaskId).toBe(taskId);
    expect(state.mosesGuestPilotIntent).toBeUndefined();

    await req.remove();
    await queueInitialMosesGuestPilot({ ...args, eventId: 'second-create' }, prepare);
    await queueInitialMosesGuestPilot(args, prepare);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await req.get()).exists()).toBe(false);
  });

  it('reconciles an unknown send only by inspecting the same native receipt and exact task', async () => {
    provider.mockRejectedValueOnce(new Error('unknown ACK')).mockRejectedValueOnce(new Error('missing exact task'));
    await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('unknown ACK');
    await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('missing exact task');
    expect((await req.child('mosesGuestPilot').get()).exists()).toBe(false);
    await expect(queueInitialMosesGuestPilot(args, prepare)).resolves.toMatchObject({ action: 'queued' });
    const [first, second, third] = provider.mock.calls;
    expect([first[0], second[0], third[0]]).toEqual(['create', 'inspect', 'inspect']);
    expect(first.slice(1)).toEqual(second.slice(1));
    expect(first.slice(1)).toEqual(third.slice(1));
  });

  it('does not authorize work that advances while the provider ACK is outstanding', async () => {
    provider.mockImplementationOnce(async () => { await req.update({ runningTaskId: 'other' }); });
    await expect(queueInitialMosesGuestPilot(args, prepare)).resolves.toMatchObject({ action: 'unchanged' });
    await queueInitialMosesGuestPilot(args, prepare);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await req.child('mosesGuestPilot').get()).exists()).toBe(false);
  });

  it('resumes a prepared receipt both before and after writing its pending request', async () => {
    for (const pendingExists of [false, true]) {
      await req.remove();
      await receipt.remove();
      provider.mockReset().mockRejectedValueOnce(new Error('simulated interruption'));
      await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('interruption');
      const original = (await receipt.get()).val();
      await receipt.update({ phase: 'prepared' });
      if (!pendingExists) await req.remove();
      provider.mockReset().mockResolvedValue(undefined);
      await expect(queueInitialMosesGuestPilot(args, prepare)).resolves.toMatchObject({ action: 'queued', taskId: original.taskId });
      expect(provider.mock.calls[0][0]).toBe('create');
      expect(provider.mock.calls[0][2].nonce).toBe(original.nonce);
    }
  });

  it('continues through the ordinary queue on a definite decline, then rejects historical replay after cleanup or rollback', async () => {
    const disarmed = () => queueOrReplaceProcessAudioRequest({
      database, payload, targetUri: target, ownerId: `sermon-create:${eventId}`, onlyIfMissing: true,
      initialCreate: { eventId, isValidLegacySource: async () => true },
    });
    for (const reason of ['authorization_unavailable', 'create_rejected', 'source_changed']) {
      await req.remove();
      await receipt.remove();
      mockOrdinaryEnqueue.mockClear();
      provider.mockReset().mockRejectedValue(new PilotTaskNotCreated('denied'));
      const prepareThis = reason === 'authorization_unavailable' ? async () => { throw new Error('auth unavailable'); } : prepare;
      const result = await queueInitialMosesGuestPilot({ ...args, isCurrentCreate: async () => reason !== 'source_changed' }, prepareThis);
      expect(result.action).toBe('queued');
      expect(mockOrdinaryEnqueue).toHaveBeenCalledTimes(1);
      expect((await receipt.get()).val()).toMatchObject({ phase: 'legacy_sending', reason });
      expect((await req.child('mosesGuestPilot').get()).exists()).toBe(false);
      await req.remove();
      await disarmed();
      expect(mockOrdinaryEnqueue).toHaveBeenCalledTimes(1);
    }
    await req.remove();
    await receipt.remove();
    mockOrdinaryEnqueue.mockClear();
    provider.mockReset().mockResolvedValue(undefined);
    await queueInitialMosesGuestPilot(args, prepare);
    await req.remove();
    await disarmed();
    expect(mockOrdinaryEnqueue).not.toHaveBeenCalled();
  });

  it('coalesces the competing uploader on a pending unknown or confirmed pilot', async () => {
    const callable = () => queueOrReplaceProcessAudioRequest({ database, payload, targetUri: target, ownerId: 'browser' });
    provider.mockRejectedValueOnce(new Error('unknown ACK'));
    await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('unknown ACK');
    await expect(callable()).resolves.toMatchObject({ action: 'unchanged' });
    await queueInitialMosesGuestPilot(args, prepare);
    await expect(callable()).resolves.toMatchObject({ action: 'unchanged' });
    expect(mockOrdinaryEnqueue).not.toHaveBeenCalled();
  });

  it.each(['sending', 'acknowledged'])('preserves the latest serial edit behind a %s incumbent', async phase => {
    if (phase === 'sending') {
      provider.mockRejectedValueOnce(new Error('unknown ACK'));
      await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('unknown ACK');
    } else {
      await queueInitialMosesGuestPilot(args, prepare);
    }
    const original = (await req.get()).val();
    const firstEdit = { ...payload, duration: 9 };
    const latest = { id: sermonId, storageFilePath: `sermons/${sermonId}`, startTime: 3, duration: 12 };
    const enqueueEdit = (data: typeof firstEdit | typeof latest) =>
      queueOrReplaceProcessAudioRequest({ database, payload: data, targetUri: target, ownerId: 'uploader-edit' });
    await expect(enqueueEdit(firstEdit)).resolves.toMatchObject({ action: 'running_replaced' });
    await expect(enqueueEdit(latest)).resolves.toMatchObject({ action: 'running_replaced' });
    await expect(enqueueEdit(payload)).resolves.toMatchObject({ action: 'unchanged' });
    await expect(enqueueEdit(latest)).resolves.toMatchObject({ action: 'unchanged' });
    const staged = (await req.get()).val();
    expect(staged).toEqual({
      ...original, nextPayload: sanitizeProcessAudioPayload(latest),
      nextRequestVersion: computeProcessAudioRequestVersion(latest), nextUpdatedAt: expect.any(String),
    });
    if (phase === 'sending') {
      await expect(queueInitialMosesGuestPilot({ ...args, isCurrentCreate: async () => false }, prepare))
        .resolves.toMatchObject({ action: 'queued' });
      expect((await req.child('mosesGuestPilot').get()).val()).toEqual(original.mosesGuestPilotIntent);
    }
    expect((await req.child('nextPayload').get()).val()).toEqual(staged.nextPayload);
    expect(provider.mock.calls.filter(([operation]) => operation === 'create')).toHaveLength(1);
    expect(mockOrdinaryEnqueue).not.toHaveBeenCalled();
  });

  it.each(['original', 'successor'])('continues the live %s source after a proven pre-send decline', async liveSource => {
    provider.mockRejectedValueOnce(new Error('interrupt before replay'));
    await expect(queueInitialMosesGuestPilot(args, prepare)).rejects.toThrow('interrupt');
    await receipt.update({ phase: 'prepared' });
    const successor = { id: sermonId, storageFilePath: `sermons/${sermonId}`, startTime: 3, duration: 12 };
    await queueOrReplaceProcessAudioRequest({ database, payload: successor, targetUri: target, ownerId: 'edit' });
    const isValidLegacySource = jest.fn(async (next?: unknown) => liveSource === 'successor' ? !!next : !next);
    const result = await queueInitialMosesGuestPilot({ ...args, isCurrentCreate: async () => false, isValidLegacySource }, prepare);
    const active = liveSource === 'successor' ? successor : payload;
    expect(result).toMatchObject({ action: 'queued', requestVersion: computeProcessAudioRequestVersion(active) });
    expect(isValidLegacySource).toHaveBeenCalledWith(sanitizeProcessAudioPayload(successor));
    expect(mockOrdinaryEnqueue).toHaveBeenCalledTimes(1);
    expect(mockOrdinaryEnqueue.mock.calls[0][0]).toEqual(sanitizeProcessAudioPayload(active));
    expect((await req.child('mosesGuestPilotIntent').get()).exists()).toBe(false);
    expect((await req.child('nextPayload').get()).val()).toEqual(liveSource === 'successor' ? null : sanitizeProcessAudioPayload(successor));
  });

  it('leaves pre-existing, deferred, locked, or changed work alone', async () => {
    for (const ref of [req, deferred, lock]) {
      await ref.set({ existing: true });
      await expect(queueInitialMosesGuestPilot(args, prepare)).resolves.toMatchObject({ action: 'unchanged' });
      expect((await ref.get()).val()).toEqual({ existing: true });
      await ref.remove();
    }
    await expect(queueInitialMosesGuestPilot({ ...args, isCurrentCreate: async () => false, isValidLegacySource: async () => false }, prepare))
      .resolves.toMatchObject({ action: 'unchanged' });
    expect(provider).not.toHaveBeenCalled();
    expect(mockOrdinaryEnqueue).not.toHaveBeenCalled();
  });
});

describe('Moses dedicated Cloud Tasks transport', () => {
  const data = sanitizeProcessAudioPayload(payload);
  const requestVersion = computeProcessAudioRequestVersion(data);
  const queuedAt = now.toISOString();
  const taskId = computeProcessAudioTaskId(sermonId, requestVersion, `sermon-create:${eventId}:${queuedAt}`);
  const intent: PilotSendIntent = { eventId, requestVersion, queuedAt, taskId, nonce: 'one-opaque-attempt' };
  const apiRoot = 'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks';
  const authorize = async () => 'synthetic-token';
  const task = {
    name: `projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/${taskId}`,
    scheduleTime: '2026-01-10T12:16:15.000Z',
    dispatchDeadline: '1800s',
    httpRequest: {
      url: target, httpMethod: 'POST', headers: { 'Content-Type': 'application/json', 'x-urm-moses-pilot-intent': intent.nonce },
      body: Buffer.from(JSON.stringify({ data })).toString('base64'),
      oidcToken: { audience: target, serviceAccountEmail: 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com' },
    },
  };
  it('uses one exact named task with task-level OIDC on the existing production queue', async () => {
    const fetcher = jest.fn(async (_input: unknown, _init?: RequestInit) => Response.json(task));
    await sendLegacyMosesPilotTask('create', data, intent, fetcher, authorize);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(apiRoot);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({ task, responseView: 'FULL' });
    await sendLegacyMosesPilotTask('inspect', data, intent, fetcher, authorize);
    expect(fetcher.mock.calls[1]).toEqual([`${apiRoot}/${taskId}?responseView=FULL`, expect.objectContaining({ method: 'GET' })]);
  });

  it('rejects a tombstone, a conflict, missing provider data and mismatched task or authority', async () => {
    for (const response of [
      new Response(null, { status: 404 }), new Response(null, { status: 409 }), Response.json({ name: task.name }),
      Response.json({ ...task, name: 'other' }), Response.json({ ...task, dispatchCount: 1 }),
      ...[{ url: 'https://other.test' }, { body: 'other' }, { headers: {} },
        { oidcToken: { ...task.httpRequest.oidcToken, audience: 'other' } },
        { oidcToken: { ...task.httpRequest.oidcToken, serviceAccountEmail: 'other' } },
      ].map(fields => Response.json({ ...task, httpRequest: { ...task.httpRequest, ...fields } })),
    ]) {
      const fetcher = jest.fn(async () => response);
      await expect(sendLegacyMosesPilotTask('inspect', data, intent, fetcher, authorize)).rejects.toThrow('did not confirm');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
