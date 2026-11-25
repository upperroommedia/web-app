import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { computeProcessAudioRequestVersion, computeProcessAudioTaskId, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import { canonicalMosesRecoveryJson, computeMosesBacklogCustody, MOSES_BACKLOG_FENCES_PATH, mosesBacklogDocumentFence,
  mosesRecoveryDigest, type MosesBacklogReceipt, type MosesBacklogKind } from '@upperroom/contracts/mosesDeferredRecovery';
import { recoverMosesBacklogRequest, type BacklogSelection, type MosesBacklogDependencies } from '../../../../functions-media/src/mosesBacklogRecovery';
import { queueOrReplaceProcessAudioRequest } from '../../../../functions-media/src/processAudioQueueStore';
import { MOSES_BACKLOG_SURFACES, verifyMosesBacklogWitness } from '../../../../functions-media/src/mosesBacklogWitness';
import type { Bucket } from '@google-cloud/storage';
import { MOSES_BACKLOG_DOCUMENT_FENCES } from '@upperroom/contracts/mosesDeferredRecovery';
import { buildFirebaseStorageDownloadUrl } from '@upperroom/shared/shared/firebaseStorageUrls';
import { pinBacklogBumper, verifyNativeBacklogDocumentFence } from '../../../../functions-media/src/mosesBacklogNative';
import type { PilotTransport } from '../../../../functions-media/src/legacyMosesGuestPilot';

import { getMosesRecoveryCohortMember, type MosesRecoveryCohortMember } from '@upperroom/contracts/mosesDeferredRecovery';
import { assertOtherCohortRowsIdle, getMosesRecoveryRoute } from '../../../../functions-media/src/recoverDeferredMosesAudio';

const sermonId = 'backlog-test-v2', videoId = 'abcdefghijk', releaseSha = 'a'.repeat(40);
const payload = sanitizeProcessAudioPayload({ id: sermonId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
  startTime: 12, duration: 24, deleteOriginal: true, introUrl: 'https://example.invalid/intro', outroUrl: 'https://example.invalid/outro' });
const requestVersion = computeProcessAudioRequestVersion(payload);
const nativeHead = { payload, documentCreateTime: '101.000000001', documentUpdateTime: '202.000000001',
  bumperGenerations: { intro: { path: 'intros/default_intro.mp3', generation: '12' }, outro: { path: 'outros/default_outro.mp3', generation: '13' } } };
const previous = { sermonId, sourceType: 'youtube', currentPayload: payload, currentRequestVersion: requestVersion,
  queuedAt: '2026-11-20T00:00:00.000Z', queuedTaskId: computeProcessAudioTaskId(sermonId, requestVersion, 'old'), transientRetryCount: 0, updatedAt: '2026-11-20T00:10:00.000Z' };
const database = firebaseAdmin.database();
const fence = database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${sermonId}`);
const request = database.ref(`processAudioRequests/${sermonId}`);

function scenario(kind: MosesBacklogKind) {
  const selection: BacklogSelection = { kind, sermonId, videoId, releaseSha, ...(kind === 'failed_request' && { requestVersion }) };
  const provider = jest.fn<ReturnType<PilotTransport>, Parameters<PilotTransport>>().mockResolvedValue(undefined);
  const deps = {
    database,
    readHead: jest.fn<ReturnType<MosesBacklogDependencies['readHead']>, Parameters<MosesBacklogDependencies['readHead']>>().mockResolvedValue(nativeHead),
    verifyDocumentFence: jest.fn<ReturnType<MosesBacklogDependencies['verifyDocumentFence']>, Parameters<MosesBacklogDependencies['verifyDocumentFence']>>().mockResolvedValue(undefined),
    readWitness: jest.fn<ReturnType<MosesBacklogDependencies['readWitness']>, Parameters<MosesBacklogDependencies['readWitness']>>().mockResolvedValue(null),
    prepare: async () => provider,
  };
  const preview = () => recoverMosesBacklogRequest('preview', selection, deps);
  const apply = (digest: string) => recoverMosesBacklogRequest('apply', { ...selection, requestVersion, custodySha256: digest }, deps);
  return { preview, apply, deps, provider };
}

describe('same-sermon backlog forward exclusion', () => {
  beforeEach(async () => {
    await Promise.all([fence.remove(), request.remove(), database.ref(`processAudioLocks/${sermonId}`).remove(),
      database.ref(`processAudioQueues/youtube/deferred/${sermonId}`).remove()]);
  });
  it.each(['failed_request', 'missing_admission'] as const)('never sends from mere current absence, then sends at most once for %s', async kind => {
    if (kind === 'failed_request') await request.set(previous);
    const { preview, apply, deps, provider } = scenario(kind);
    const plan = await preview();
    expect(plan.phase).toBe('eligible_to_fence');
    expect((await fence.get()).exists()).toBe(false);
    expect((await apply(plan.custodySha256)).phase).toBe('fenced');
    const original = (await fence.get()).val();
    expect(original).toMatchObject({ ...nativeHead, requestVersion, requestSha256: mosesRecoveryDigest(kind === 'failed_request' ? previous : null),
      ...(kind === 'failed_request' && { priorTaskId: previous.queuedTaskId }) });
    expect(deps.verifyDocumentFence).toHaveBeenCalledWith(original, true);
    expect(mosesBacklogDocumentFence(original)).toMatchObject({ nonce: original.nonce, documentUpdateTime: nativeHead.documentUpdateTime });
    expect((await apply(plan.custodySha256)).phase).toBe('waiting_for_witness');
    expect(provider).not.toHaveBeenCalled();
    expect((await request.get()).val()).toEqual(kind === 'failed_request' ? previous : null);

    deps.readWitness.mockImplementation(async () => ({ generation: '17', sha256: 'b'.repeat(64), observedAt: new Date().toISOString(), releaseSha }));
    provider.mockRejectedValueOnce(new Error('lost ACK')).mockRejectedValueOnce(new Error('provider 404'));
    await expect(apply(plan.custodySha256)).rejects.toThrow('unknown');
    await expect(apply(plan.custodySha256)).rejects.toThrow('404');
    expect((await fence.get()).val().phase).toBe('sending');
    expect((await apply(plan.custodySha256)).phase).toBe('acknowledged');
    await apply(plan.custodySha256);
    expect(provider.mock.calls.map(([op]) => op)).toEqual(['create', 'inspect', 'inspect']);
    expect(provider.mock.calls[0].slice(1)).toEqual(provider.mock.calls[2].slice(1));
    expect((await request.get()).val()).toEqual(kind === 'failed_request' ? previous : null);
  });
  it('holds request drift, generation drift, old proofs and incomplete native mirrors before any send', async () => {
    await request.set(previous);
    const { preview, apply, deps, provider } = scenario('failed_request');
    const { custodySha256 } = await preview();
    await apply(custodySha256);
    deps.readHead.mockResolvedValueOnce({ ...nativeHead, bumperGenerations: { ...nativeHead.bumperGenerations, intro: { path: 'intros/default_intro.mp3', generation: '20' } } });
    await expect(apply(custodySha256)).rejects.toThrow();
    deps.verifyDocumentFence.mockRejectedValueOnce(new Error('foreign mirror'));
    await expect(apply(custodySha256)).rejects.toThrow('foreign mirror');
    deps.readWitness.mockResolvedValueOnce({ generation: '12', sha256: 'b'.repeat(64), releaseSha, observedAt: '2026-01-01T00:00:00.000Z' });
    await expect(apply(custodySha256)).rejects.toThrow();
    await request.update({ queuedTaskId: 'replacement-task' });
    await expect(apply(custodySha256)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });
  it('blocks an ordinary retry before its status write and refuses to reconstruct over newly admitted work', async () => {
    const { preview, apply } = scenario('missing_admission');
    const { custodySha256 } = await preview();
    await apply(custodySha256);
    const markPending = jest.fn(async () => undefined);
    await expect(queueOrReplaceProcessAudioRequest({ database, payload, targetUri: 'https://example.invalid', ownerId: 'old-client', markPending }))
      .rejects.toThrow('Recovery owns');
    expect(markPending).not.toHaveBeenCalled();
    await expect(queueOrReplaceProcessAudioRequest({ database, payload, targetUri: 'https://example.invalid', ownerId: 'old-create',
      onlyIfMissing: true, initialCreate: {eventId: 'historic-create', isValidLegacySource: async () => true} }))
      .resolves.toMatchObject({ action: 'unchanged', requestVersion });
    expect((await request.get()).exists()).toBe(false);
    await request.set(previous);
    await expect(apply(custodySha256)).rejects.toThrow();
    expect((await request.get()).val()).toEqual(previous);
  });
});

function sshField(value: string | Buffer) {
  const body = Buffer.from(value), n = Buffer.alloc(4); n.writeUInt32BE(body.length);
  return Buffer.concat([n, body]);
}

describe('forward drain release attestation', () => {
  const key = generateKeyPairSync('ed25519');
  const publicBlob = Buffer.concat([sshField('ssh-ed25519'), sshField(key.publicKey.export({type: 'spki', format:'der'}).subarray(-32))]);
  const fingerprint = 'SHA256:' + createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/u, '');
  const now = Date.parse('2026-11-25T01:00:00.000Z');
  const when = new Date(now - 1000).toISOString();
  const receipt: MosesBacklogReceipt = { ...nativeHead, schema: 2, kind:'failed_request', sermonId, videoId, requestVersion,
    requestSha256: mosesRecoveryDigest(previous), priorTaskId: previous.queuedTaskId, releaseSha, custodySha256: '', taskId:'test',
    fencedAt: new Date(now - 10_000).toISOString(), nonce:'00000000-0000-4000-8000-000000000001', phase:'fenced' };
  receipt.custodySha256 = computeMosesBacklogCustody(receipt);
  const surfaces = Object.fromEntries(Object.entries(MOSES_BACKLOG_SURFACES).map(([id,target]) => [id, {
    target, releaseSha, nativeIds: ['native-' + id], unguardedOwners: [], readAt:when, evidenceSha256:'b'.repeat(64),
  }]));
  const statement = { schema:1, kind:'moses_backlog_forward_exclusion', project:'urm-app', sermonId, requestVersion,
    custodySha256: receipt.custodySha256, nonce:receipt.nonce, fencedAt:receipt.fencedAt, releaseSha, observedAt:when, surfaces };
  function envelope(proof: unknown, namespace = 'urm-moses-backlog-drain-v1') {
    const hash = createHash('sha512').update(canonicalMosesRecoveryJson(proof)).digest();
    const data = Buffer.concat([Buffer.from('SSHSIG'), sshField(namespace), sshField(''), sshField('sha512'), sshField(hash)]);
    const sig = Buffer.concat([sshField('ssh-ed25519'), sshField(sign(null,data,key.privateKey))]);
    const envelope = Buffer.concat([Buffer.from('SSHSIG'), Buffer.from([0,0,0,1]),sshField(publicBlob),sshField(namespace),sshField(''),sshField('sha512'),sshField(sig)]);
    return Buffer.from(JSON.stringify({statement:proof, signature:`-----BEGIN SSH SIGNATURE-----\n${envelope.toString('base64')}\n-----END SSH SIGNATURE-----\n`}));
  }
  it('accepts the pinned release signature only after every native writer observed the installed fence', () => {
    expect(verifyMosesBacklogWitness(envelope(statement),receipt,fingerprint,now)).toBe(when);
    const target = 'hetzner-youtube';
    for (const bad of [
      { ...statement, nonce:'other' }, { ...statement, releaseSha:'other' }, { ...statement, observedAt:'2026-11-24T00:00:00.000Z' },
      { ...statement, surfaces:{} }, ...[{target:'https://other'}, {nativeIds:[]}, {unguardedOwners:['old-runner']}, {evidenceSha256:'bad'},
        {readAt:'2026-11-24T00:00:00.000Z'}].map(mod => ({...statement,surfaces:{...surfaces,[target]:{...surfaces[target],...mod}}})),
    ]) expect(()=>verifyMosesBacklogWitness(envelope(bad),receipt,fingerprint,now)).toThrow();
    expect(()=>verifyMosesBacklogWitness(envelope(statement,'other'),receipt,fingerprint,now)).toThrow();
    expect(()=>verifyMosesBacklogWitness(envelope(statement),receipt,'SHA256:'+'a'.repeat(43),now)).toThrow();
    const altered = JSON.parse(envelope(statement).toString()); altered.statement.observedAt = new Date(now).toISOString();
    expect(()=>verifyMosesBacklogWitness(Buffer.from(JSON.stringify(altered)),receipt,fingerprint,now)).toThrow();
  });
});

describe('native backlog admission evidence', () => {
  it('installs a permanent Firestore mirror against the exact source revision and holds later edits', async () => {
    const db = firebaseAdmin.firestore();
    const doc = db.collection('sermons').doc();
    const mirror = db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(doc.id);
    try {
      await doc.create({ status: { audioStatus: 'ERROR' } });
      const before = await doc.get();
      const timestamp = (time: { seconds: number; nanoseconds: number }) =>
        `${time.seconds}.${String(time.nanoseconds).padStart(9, '0')}`;
      const frozen: MosesBacklogReceipt = {
        ...nativeHead, schema: 2, kind: 'failed_request', sermonId: doc.id, videoId, requestVersion,
        requestSha256: mosesRecoveryDigest(previous), priorTaskId: previous.queuedTaskId,
        documentCreateTime: timestamp(before.createTime!), documentUpdateTime: timestamp(before.updateTime!),
        releaseSha, custodySha256: 'c'.repeat(64), taskId: 'mr-test', phase: 'fenced',
        nonce: '00000000-0000-4000-8000-000000000002', fencedAt: new Date().toISOString(),
      };
      await expect(verifyNativeBacklogDocumentFence(frozen, false)).rejects.toThrow();
      await verifyNativeBacklogDocumentFence(frozen, true);
      await verifyNativeBacklogDocumentFence(frozen, true);
      expect((await mirror.get()).data()).toEqual(mosesBacklogDocumentFence(frozen));
      expect((await doc.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
      await expect(verifyNativeBacklogDocumentFence({ ...frozen, nonce: 'foreign' }, true)).rejects.toThrow();
      await doc.update({ title: 'new source revision' });
      await expect(verifyNativeBacklogDocumentFence(frozen, true)).rejects.toThrow();
      expect((await mirror.get()).data()).toEqual(mosesBacklogDocumentFence(frozen));
    } finally {
      await Promise.all([doc.delete(), mirror.delete()]);
    }
  });

  it('requires the correct native generation, object name, bucket and original download token', async () => {
    const bucketName = 'urm-app.appspot.com';
    const name = 'intros/default_intro.mp3';
    const savedUrl = buildFirebaseStorageDownloadUrl(bucketName, name, 'original-download-token');
    const metadata = { bucket: bucketName, name, generation: '128', size: '441', metadata: { firebaseStorageDownloadTokens: 'original-download-token' } };
    const getMetadata = jest.fn(async () => [metadata]);
    const file = jest.fn(() => ({ exists: async () => [false], getMetadata }));
    const bucket = { file } as unknown as Bucket;
    const expected = { url: savedUrl, pin: { path: name, generation: '128' } };
    await expect(pinBacklogBumper(bucket, 'intro', 'class', savedUrl)).resolves.toEqual(expected);
    await expect(pinBacklogBumper(bucket, 'intro', undefined)).resolves.toEqual(expected);
    await expect(pinBacklogBumper(bucket, 'intro', 'class')).resolves.toEqual(expected);
    expect(file).toHaveBeenCalledWith('intros/class_intro.mp3');
    for (const patch of [{ generation: '' }, { size: '0' }, { bucket: 'other' }, { name: 'wrong' }, { metadata: { firebaseStorageDownloadTokens:'foreign' } }]) {
      getMetadata.mockResolvedValueOnce([{ ...metadata, ...patch }]);
      await expect(pinBacklogBumper(bucket, 'intro', 'class', savedUrl)).rejects.toThrow();
    }
    await expect(pinBacklogBumper(bucket, 'intro', 'illegal/path')).rejects.toThrow();
    await expect(pinBacklogBumper(bucket, 'outro', 'class', savedUrl)).rejects.toThrow();
  });
});

import { MOSES_BACKLOG_EDITS_PATH, MOSES_BACKLOG_RELEASES, computeMosesBacklogTaskId } from '@upperroom/contracts/mosesDeferredRecovery';
import { grantNativeMosesBacklogEdit, queueCompletedBacklogEdit, type BacklogEditDependencies } from '../../../../functions-media/src/mosesBacklogEdit';

describe('post-terminal authenticated edit', () => {
  const db = firebaseAdmin.firestore(), bucketName = 'urm-app.appspot.com';
  const owner = 'editor-test-claim';
  const completedAt = '2026-01-01T00:00:00.000Z';
  async function fixture() {
    const doc = db.collection('sermons').doc();
    const id = doc.id;
    const mirror = db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(id);
    const release = db.collection(MOSES_BACKLOG_RELEASES).doc(id);
    const editHead = database.ref(MOSES_BACKLOG_EDITS_PATH + '/' + id);
    const rowRef = database.ref('processAudioRequests/' + id);
    const fenceRef = database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + id);
    const claim = database.ref('processAudioQueueClaims/' + id);
    const urls = { introUrl: buildFirebaseStorageDownloadUrl(bucketName, 'intros/default_intro.mp3', 'token'),
      outroUrl: buildFirebaseStorageDownloadUrl(bucketName, 'outros/default_outro.mp3', 'token') };
    const original = sanitizeProcessAudioPayload({ ...payload, ...urls, id, deleteOriginal: true });
    const edited = { ...original, startTime: 27, deleteOriginal: false };
    const oldVersion = computeProcessAudioRequestVersion(original);
    const row = { sermonId:id, sourceType:'youtube', currentPayload:original, currentRequestVersion:oldVersion,
      lastCompletedRequestVersion:oldVersion, lastCompletedAt:completedAt, updatedAt:completedAt };
    await doc.create({ status:{ audioStatus:'PROCESSED', subsplash:'NOT_UPLOADED', soundCloud:'NOT_UPLOADED' }, uploaderId:'owner',
      youtubeUrl:'https://www.youtube.com/watch?v=' + videoId, sourceStartTime:edited.startTime, trimDurationSeconds:edited.duration, subtitle:'' });
    const created = (await doc.get()).createTime!;
    const nativeTime = created.seconds + '.' + String(created.nanoseconds).padStart(9,'0');
    const t = { ...nativeHead, payload:original, schema:2 as const, kind:'missing_admission' as const, sermonId:id, videoId,
      requestVersion:oldVersion, requestSha256:mosesRecoveryDigest(null), documentCreateTime:nativeTime, documentUpdateTime:nativeTime, releaseSha,
      owner:'recovery-owner', outcome:'completed', phase:'consumed' as const, nonce:'00000000-0000-4000-8000-000000000001',
      fencedAt:completedAt, custodySha256:'', taskId:'', completedRequestSha256:mosesRecoveryDigest(row),
      witness:{ generation:'7', sha256:'a'.repeat(64), observedAt:completedAt, releaseSha },
      proof:{ completedAt, documentWriteTime:'1.000000001', outputs:{
        processed:{path:'processed-sermons/'+id,generation:'100',bytes:'52'}, final:{path:'intro-outro-sermons/'+id,generation:'101',bytes:'52'} } } };
    t.custodySha256=computeMosesBacklogCustody(t); t.taskId=computeMosesBacklogTaskId(t.kind,id,oldVersion,t.custodySha256);
    await Promise.all([mirror.create(mosesBacklogDocumentFence(t)), rowRef.set(row), fenceRef.set(t), claim.set({requestId:owner,acquiredAt:Date.now()})]);
    const bucket = { name:bucketName, file:(name:string) => ({ exists:async()=>[true], getMetadata:async()=>[{
      name,bucket:bucketName,size:'52',contentType:'audio/mpeg',generation:name.startsWith('intro-outro-sermons/') ? '101' : '100',
      metadata: { firebaseStorageDownloadTokens:'token',urmBacklogTask:t.taskId } }] }) } as unknown as Bucket;
    const enqueue = jest.fn<Promise<void>, Parameters<BacklogEditDependencies['enqueue']>>().mockResolvedValue(undefined);
    const submit = (uid='owner', terminal:MosesBacklogReceipt=t, data=edited) => queueCompletedBacklogEdit(terminal, data, owner, {
      database,editor:{uid,role:'uploader'},authorize: args => grantNativeMosesBacklogEdit(db,bucket,args),enqueue,
    });
    const clean = async() => {
      const grants = await release.collection('tasks').get();
      await Promise.all([doc.delete(),mirror.delete(),release.delete(),editHead.remove(),rowRef.remove(),fenceRef.remove(),claim.remove(),
        ...grants.docs.map(g => g.ref.delete())]);
    };
    return { submit, enqueue, rowRef, fenceRef, editHead, doc, release, mirror, t, edited, clean };
  }

  it('holds nonterminal, foreign-editor and same-source attempts, then issues one direct grant leaving the originals intact', async()=>{
    const f=await fixture();
    try {
      await expect(f.submit('owner',{...f.t,phase:'acknowledged'})).rejects.toThrow();
      await expect(f.submit('other')).rejects.toThrow();
      await expect(f.submit('owner',f.t,{...f.edited,startTime: f.t.payload.startTime})).rejects.toThrow();
      expect((await f.release.get()).exists).toBe(false);
      const receiptBefore=(await f.fenceRef.get()).val(), mirrorBefore=(await f.mirror.get()).data();
      const queued=await f.submit();
      const grant=(await f.release.collection('tasks').doc(queued.taskId).get());
      expect(f.enqueue).toHaveBeenCalledTimes(1);
      expect(f.enqueue.mock.calls[0]).toEqual([f.edited,queued.taskId,grant.get('nonce')]);
      expect(grant.createTime!.isEqual((await f.doc.get()).updateTime!)).toBe(true);
      expect(grant.get('payloadSha256')).toBe(mosesRecoveryDigest(f.edited));
      expect((await f.rowRef.get()).child('queuedTaskId').val()).toBe(queued.taskId);
      expect((await f.editHead.get()).child('phase').val()).toBe('acknowledged');
      await expect(f.submit()).rejects.toThrow();
      expect((await f.fenceRef.get()).val()).toEqual(receiptBefore);
      expect((await f.mirror.get()).data()).toEqual(mirrorBefore);
      expect(f.enqueue).toHaveBeenCalledTimes(1);
      const originalRelease = (await f.release.get()).data();
      await f.rowRef.update({ queuedTaskId:null, queuedAt:null, lastCompletedRequestVersion:queued.requestVersion,
        lastCompletedAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
      const next = { ...f.edited, duration:f.edited.duration + 3 };
      await f.doc.update({ 'status.audioStatus':'PROCESSED', trimDurationSeconds:next.duration });
      const second = await f.submit('owner', f.t, next);
      expect(second.taskId).not.toBe(queued.taskId);
      expect((await f.release.get()).data()).toEqual(originalRelease);
      expect((await f.release.collection('tasks').get()).size).toBe(2);
      expect(f.enqueue).toHaveBeenCalledTimes(2);
    } finally { await f.clean(); }
  });

  it('keeps a lost provider acknowledgement spent across retries and never grants a different edit', async()=>{
    const f=await fixture();
    try {
      f.enqueue.mockRejectedValueOnce(new Error('timeout'));
      await expect(f.submit()).rejects.toThrow('unknown');
      await expect(f.submit()).rejects.toThrow();
      expect((await f.editHead.get()).child('phase').val()).toBe('sending');
      expect((await f.rowRef.get()).child('currentRequestVersion').val()).toBe(f.t.requestVersion);
      expect(f.enqueue).toHaveBeenCalledTimes(1);
      expect((await f.release.collection('tasks').get()).size).toBe(1);
    } finally { await f.clean(); }
  });
});

describe('deployment-pinned recovery cohort', () => {
  const missing: MosesRecoveryCohortMember = { ref: 'row-01', kind: 'missing_admission', sermonId: 'cohort-missing', videoId };
  const failed: MosesRecoveryCohortMember = { ref: 'row-02', kind: 'failed_request', sermonId: 'cohort-failed', videoId, requestVersion };
  const encode = (rows: unknown[]) => Buffer.from(JSON.stringify({ schema: 1, rows })).toString('base64url');
  const env = {
    PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: encode([missing, failed]),
    PROCESS_AUDIO_MOSES_RECOVERY_ENABLED: 'true',
    PROCESS_AUDIO_MOSES_BACKLOG_RELEASE_SHA: releaseSha,
  };
  const headers = { 'x-urm-recovery-custody': ['a'.repeat(64)], 'x-urm-recovery-witness-generation': ['778'] };
  it('can preview one declared row and apply only that exact ref and digest', () => {
    const query = { ref: missing.ref };
    expect(getMosesRecoveryCohortMember(env, missing.sermonId)).toEqual(missing);
    expect(getMosesRecoveryRoute(env, false, query, {})).toMatchObject({ backlog: { kind: missing.kind, sermonId: missing.sermonId }, peers: [failed] });
    expect(getMosesRecoveryRoute(env, true, query, headers)).toMatchObject({ backlog: {
      deriveCohortMissingVersion: true, custodySha256: headers['x-urm-recovery-custody'][0], witnessGeneration: '778',
    } });
    expect(getMosesRecoveryRoute(env, true, query, {})).toBeNull();
    expect(getMosesRecoveryRoute(env, false, query, headers)).toBeNull();
    expect(getMosesRecoveryRoute(env, true, { ref: [missing.ref] }, headers)).toBeNull();
    expect(getMosesRecoveryRoute(env, true, { ref: 'foreign' }, headers)).toBeNull();
    expect(getMosesRecoveryRoute(env, true, { ...query, path: 'foreign' }, headers)).toBeNull();
    expect(getMosesRecoveryRoute(env, true, query, { ...headers, 'x-urm-recovery-custody': [...headers['x-urm-recovery-custody'], 'b'.repeat(64)] })).toBeNull();
    for (const generation of ['0001', '9007199254740992', '../123', '0']) {
      expect(getMosesRecoveryRoute(env, true, query, { ...headers, 'x-urm-recovery-witness-generation': [generation] })).toBeNull();
    }
  });
  it('rejects the entire deployment list on extra authority fields, ambiguous rows or an invalid envelope', () => {
    for (const rows of [[], [missing, missing], [missing, { ...failed, ref: missing.ref }], [missing, { ...failed, sermonId: missing.sermonId }],
      [{ ...missing, ref: '../01' }], [{ ...missing, kind: 'failed_request' }], [{ ...missing, url: 'foreign' }],
      Array.from({ length: 15 }, (_, i) => ({ ...missing, ref: 'row-' + i, sermonId: 'sermon-' + i }))]) {
      expect(getMosesRecoveryCohortMember({ ...env, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: encode(rows) }, missing.sermonId)).toBeNull();
    }
    expect(getMosesRecoveryCohortMember({ ...env, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: env.PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL + '=' }, missing.sermonId)).toBeNull();
  });
  it('keeps all other originals held while an already selected peer is unresolved', async () => {
    const peer = database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + failed.sermonId);
    try {
      await peer.remove();
      await expect(assertOtherCohortRowsIdle(database, [failed])).resolves.toBeUndefined();
      await peer.set({ ...failed, phase: 'sending' });
      await expect(assertOtherCohortRowsIdle(database, [failed])).rejects.toThrow();
      await peer.update({ phase: 'consumed', outcome: 'review_required' });
      await expect(assertOtherCohortRowsIdle(database, [failed])).rejects.toThrow();
      await peer.update({ outcome: 'completed', owner: 'worker', proof: { completedAt: 'native' } });
      await expect(assertOtherCohortRowsIdle(database, [failed])).rejects.toThrow();
      const evidence = { ...nativeHead, schema: 2 as const, kind: 'failed_request' as const, sermonId: failed.sermonId,
        videoId, requestVersion, priorTaskId: previous.queuedTaskId, releaseSha, requestSha256: mosesRecoveryDigest(previous) };
      const digest = computeMosesBacklogCustody(evidence);
      await peer.set({ ...evidence, custodySha256: digest,
        taskId: computeMosesBacklogTaskId(evidence.kind, failed.sermonId, requestVersion, digest),
        phase: 'consumed', outcome: 'completed', owner: 'native-worker', completedRequestSha256: 'a'.repeat(64),
        proof: { documentWriteTime: '1000.000000001', completedAt: '2026-10-01T00:00:00.000Z', authority: 'cookie_provider', mosesVerified: false } });
      await expect(assertOtherCohortRowsIdle(database, [failed])).resolves.toBeUndefined();
    } finally { await peer.remove(); }
  });
});
