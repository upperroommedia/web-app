const mockTaskDelete = jest.fn(async (_taskId?: string) => undefined);
const mockTaskEnqueue = jest.fn(async (_payload?: unknown, _options?: unknown) => undefined);

jest.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({
    taskQueue: () => ({
      delete: mockTaskDelete,
      enqueue: mockTaskEnqueue,
    }),
  }),
}));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { cleanupDeletedSermonProcessAudioState } from '../../processAudioQueueCleanup';
import { buildInitialYouTubeQueueState } from '../../../../packages/contracts/processAudioQueue';

const database = firebaseAdmin.database();

describe('cleanupDeletedSermonProcessAudioState', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
      database.ref('processAudioRequests').remove(),
      database.ref('processAudioLocks').remove(),
      database.ref('processAudioQueueClaims').remove(),
      database.ref('processAudioQueues').remove(),
    ]);
  });

  it('retires a deleted probe to waiting and preserves the next browser deferral and attempted generation', async () => {
    await Promise.all([
      database.ref('processAudioRequests/deleted-sermon').set({
        sermonId: 'deleted-sermon',
        sourceType: 'youtube',
        currentPayload: {
          id: 'deleted-sermon',
          youtubeUrl: 'https://youtu.be/deleted',
          startTime: 0,
          duration: 10,
          deleteOriginal: true,
          skipTranscode: false,
        },
        currentRequestVersion: 'probe-version',
        queuedTaskId: 'probe-task-id',
        queuedAt: '2026-03-28T00:00:00.000Z',
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        updatedAt: '2026-03-28T00:00:00.000Z',
      }),
      database.ref('processAudioRequests/next-sermon').set({
        sermonId: 'next-sermon',
        sourceType: 'youtube',
        currentPayload: {
          id: 'next-sermon',
          youtubeUrl: 'https://youtu.be/next',
          startTime: 1,
          duration: 20,
          deleteOriginal: true,
          skipTranscode: false,
        },
        currentRequestVersion: 'next-version',
        queuedTaskId: null,
        queuedAt: null,
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: '2026-03-28T00:01:00.000Z',
        updatedAt: '2026-03-28T00:01:00.000Z',
      }),
      database.ref('processAudioQueues/youtube/deferred/next-sermon').set({
        sermonId: 'next-sermon',
        payload: {
          id: 'next-sermon',
          youtubeUrl: 'https://youtu.be/next',
          startTime: 1,
          duration: 20,
          deleteOriginal: true,
          skipTranscode: false,
        },
        requestVersion: 'next-version',
        deferredAt: '2026-03-28T00:01:00.000Z',
        reason: 'browser_fallback_unavailable',
        probeMode: 'browser_fallback',
        blockerEpisodeId: 'episode-1',
        lastFailureClass: 'browser_fallback_unavailable',
      }),
      database.ref('processAudioQueues/youtube/state').set({
        ...buildInitialYouTubeQueueState(),
        blocked: false,
        probeMode: 'browser_fallback',
        probeStatus: 'probing',
        probeTaskSermonId: 'deleted-sermon',
        probeRequestVersion: 'probe-version',
        probeStartedAt: '2026-03-28T00:00:30.000Z',
        deferredYouTubeTaskCount: 1,
        blockerReason: 'browser_fallback_unavailable',
        lastAttemptedAuthRecoveryGeneration: 'already-attempted',
      }),
    ]);

    const deferred = database.ref('processAudioQueues/youtube/deferred/next-sermon');
    const nextRequest = database.ref('processAudioRequests/next-sermon');
    const before = await Promise.all([deferred.get(), nextRequest.get()]);
    const clean = () => cleanupDeletedSermonProcessAudioState({ database, sermonId: 'deleted-sermon', ownerId: 'test-owner' });
    expect(await clean()).toEqual({ deletedTaskId: 'probe-task-id', advancedProbe: false, deferredRemaining: 1 });
    expect(mockTaskDelete).toHaveBeenCalledWith('probe-task-id');
    expect((await database.ref('processAudioRequests/deleted-sermon').get()).exists()).toBe(false);
    const state = database.ref('processAudioQueues/youtube/state');
    const waiting = (await state.get()).val();
    expect(waiting).toMatchObject({
      probeStatus: 'waiting_for_auth_required_request', probeMode: 'browser_fallback',
      blockerReason: 'browser_fallback_unavailable', deferredYouTubeTaskCount: 1,
      lastAttemptedAuthRecoveryGeneration: 'already-attempted',
    });
    expect(waiting.probeTaskSermonId).toBeUndefined();
    expect(waiting.probeRequestVersion).toBeUndefined();
    expect(waiting.probeStartedAt).toBeUndefined();
    expect(waiting.probeDispatchReservationId).toBeUndefined();
    expect(await clean()).toEqual({ deletedTaskId: null, advancedProbe: false, deferredRemaining: 1 });
    expect((await state.get()).val()).toEqual(waiting);
    expect((await deferred.get()).val()).toEqual(before[0].val());
    expect((await nextRequest.get()).val()).toEqual(before[1].val());
    expect(mockTaskEnqueue).not.toHaveBeenCalled();
  });

  it('keeps a newer matching-ID reservation and every other deferred row intact', async () => {
    const state = database.ref('processAudioQueues/youtube/state');
    const deferred = database.ref('processAudioQueues/youtube/deferred');
    const probe = { probeStatus: 'probing', probeMode: 'browser_fallback', probeTaskSermonId: 'deleted-sermon',
      probeRequestVersion: 'v1', probeStartedAt: '2026-03-28T00:00:00.000Z', probeDispatchReservationId: 'old',
      lastAttemptedAuthRecoveryGeneration: 'used', deferredYouTubeTaskCount: 1 };
    await Promise.all([state.set(probe), deferred.set({ neighbour: { reason: 'browser_fallback_unavailable' } })]);
    const newer = { ...probe, probeDispatchReservationId: 'new-owner', probeStartedAt: '2026-03-28T00:05:00.000Z' };
    const result = await cleanupDeletedSermonProcessAudioState({database, sermonId:'deleted-sermon', ownerId:'delete-event',
      classifySource: async () => { await state.set(newer); return 'ordinary'; } });
    expect(result.disposition).toBe('stale');
    expect((await state.get()).val()).toEqual(newer);
    expect((await deferred.get()).val()).toEqual({neighbour: {reason:'browser_fallback_unavailable'}});
    expect(mockTaskEnqueue).not.toHaveBeenCalled();
  });

  it('removes its own deferral without recounting a different in-flight reservation', async () => {
    const queue = database.ref('processAudioQueues/youtube');
    const state = { probeTaskSermonId:'other', probeStatus:'probing', probeDispatchReservationId:'active',
      probeRequestVersion:'current', deferredYouTubeTaskCount: 1, lastAttemptedAuthRecoveryGeneration:'used' };
    await queue.set({state, deferred:{deleted:{reason:'old'}, other:{reason:'keep'}}});
    await cleanupDeletedSermonProcessAudioState({database, sermonId:'deleted', ownerId:'delete-event'});
    expect((await queue.get()).val()).toEqual({state:{...state,deferredYouTubeTaskCount:0},deferred:{other:{reason:'keep'}}});
    expect(mockTaskEnqueue).not.toHaveBeenCalled();
  });
});

import type { Bucket } from '@google-cloud/storage';
import { MOSES_BACKLOG_DELETIONS, MOSES_BACKLOG_DOCUMENT_FENCES, MOSES_BACKLOG_FENCES_PATH } from '../../../../packages/contracts/mosesDeferredRecovery';
import { classifyDeletedSermon, cleanDeletedSermonDescendants, cleanDeletedSermonFile } from '../../DocumentListeners/Sermons/sermonOnDelete';

describe('native deletion ownership', () => {
  const db = firebaseAdmin.firestore();
  const deleted = { eventId: 'native-delete', eventTime: '2026-11-25T05:00:00.000Z',
    documentCreateTime: '31.000000123', deletedDocumentUpdateTime: '99.000000456' };
  it('records an exact fenced deletion once and preserves request, lock, receipt and outputs for review', async () => {
    const doc = db.collection('sermons').doc();
    const marker = db.collection(MOSES_BACKLOG_DELETIONS).doc(doc.id);
    const mirror = db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(doc.id);
    const receipt = { schema: 2, kind: 'failed_request', sermonId: doc.id, documentCreateTime: deleted.documentCreateTime,
      requestVersion: 'a'.repeat(16), custodySha256:'b'.repeat(64) };
    const fence = database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + doc.id);
    const row = database.ref('processAudioRequests/' + doc.id), lock = database.ref('processAudioLocks/' + doc.id);
    try {
      await Promise.all([mirror.create(receipt), fence.set(receipt), row.set({queuedTaskId:'original'}), lock.set({requestId:'incumbent'})]);
      const run = () => cleanupDeletedSermonProcessAudioState({database, sermonId:doc.id, ownerId:deleted.eventId,
        classifySource: value => classifyDeletedSermon(doc, deleted, value)});
      expect((await run()).disposition).toBe('held');
      const first = await marker.get();
      expect(first.data()).toEqual({schema:1, disposition:'held_source_deleted', sermonId:doc.id, custodySha256:receipt.custodySha256,
        requestVersion:receipt.requestVersion, ...deleted});
      expect((await run()).disposition).toBe('held');
      expect((await marker.get()).updateTime!.isEqual(first.updateTime!)).toBe(true);
      expect((await row.get()).val()).toEqual({queuedTaskId:'original'});
      expect((await lock.get()).val()).toEqual({requestId:'incumbent'});
      expect((await fence.get()).val()).toEqual(receipt);
    } finally { await Promise.all([marker.delete(), mirror.delete(), fence.remove(), row.remove(), lock.remove()]); }
  });

  it('ignores old deletion against a recreated live sermon, including its descendants', async () => {
    const doc = db.collection('sermons').doc();
    const child = doc.collection('sermonLists').doc('active');
    try {
      await doc.create({ title: 'current' }); await child.create({ current: true });
      await expect(classifyDeletedSermon(doc, deleted, null)).resolves.toBe('stale');
      await cleanDeletedSermonDescendants(doc, Date.now() + 1000);
      expect((await child.get()).data()).toEqual({current: true});
      expect((await doc.get()).data()).toEqual({title:'current'});
      await doc.delete();
      await cleanDeletedSermonDescendants(doc, Date.now() + 1000);
      expect((await child.get()).exists).toBe(false);
      expect((await doc.get()).exists).toBe(false);
    } finally { await Promise.all([doc.delete(), child.delete()]); }
  });

  it('deletes only the native GCS generation predating deletion', async () => {
    const remove = jest.fn(async () => undefined);
    const path = 'processed-sermons/example', name = 'bucket', t = Date.now();
    const getMetadata = jest.fn().mockResolvedValueOnce([{name:path,bucket:name,generation:'12',timeCreated:new Date(t-10).toISOString()}])
      .mockResolvedValueOnce([{name:path,bucket:name,generation:'13',timeCreated:new Date(t+10).toISOString()}]);
    const file = jest.fn((_path:string, opts?:{generation:string}) => opts ? {delete:remove} : {getMetadata});
    const bucket = {name,file} as unknown as Bucket;
    await cleanDeletedSermonFile(bucket,path,t);
    await cleanDeletedSermonFile(bucket,path,t);
    expect(file).toHaveBeenCalledWith(path,{generation:'12'});
    expect(file).not.toHaveBeenCalledWith(path,{generation:'13'});
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(['permanent-fence','deferred-reservation'])('leaves a foreign %s untouched when a deleted probe retires', async kind => {
    const source = 'deleted-probe-' + kind, candidate = 'reserved-probe-' + kind;
    const deferred = database.ref('processAudioQueues/youtube/deferred/' + candidate);
    const state = database.ref('processAudioQueues/youtube/state');
    const fence = database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + candidate);
    const entry = { sermonId:candidate, payload:{ id:candidate, youtubeUrl:'https://youtu.be/abcdefghijk', startTime:0, duration:10 },
      requestVersion:'a'.repeat(16), probeMode:'cookie_provider', deferredAt:'2026-11-25T00:00:00.000Z',
      ...(kind === 'deferred-reservation' && {mosesRecoveryReservation:{nonce:'private'}}) };
    try {
      await database.ref('processAudioQueues/youtube/deferred').remove();
      await Promise.all([deferred.set(entry),state.set({...buildInitialYouTubeQueueState(),probeTaskSermonId:source,probeStatus:'probing',
        probeMode:'cookie_provider',deferredYouTubeTaskCount:1}), ...(kind==='permanent-fence' ? [fence.set({schema:2})] : [])]);
      mockTaskEnqueue.mockClear();
      const r = await cleanupDeletedSermonProcessAudioState({database, sermonId:source, ownerId:'delete-event'});
      expect(r.advancedProbe).toBe(false);
      expect((await deferred.get()).val()).toEqual(entry);
      expect(mockTaskEnqueue).not.toHaveBeenCalled();
      expect((await state.get()).child('probeStatus').val()).toBe('waiting_for_auth_required_request');
    } finally { await Promise.all([deferred.remove(),state.remove(),fence.remove()]); }
  });
});
