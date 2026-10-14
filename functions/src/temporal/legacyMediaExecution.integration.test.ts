import express from 'express';
import { withNativeMediaHttpExecution } from '../../../apps/process-audio/src/legacyMediaHttp';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  legacyMediaAdmissionId,
  prepareLegacyMediaAdmission,
  withLegacyMediaExecution,
} from '@upperroom/orchestration/legacy-media-execution';
import { withLegacyAdmissionLease } from './legacyAdmissionLease';
import sermonAudioCreateTrigger from '../../../functions-media/src/sermonAudioCreateTrigger';
import { getYouTubeCookieStatus } from '../../../functions-media/src/youtubeCookieStore';
import {
  queueOrReplaceProcessAudioRequest,
  setYouTubeTaskQueueFactoryForTesting,
} from '../../../functions-media/src/processAudioQueueStore';

jest.mock('../../../functions-media/src/browserFallbackService', () => ({
  getBrowserFallbackSessionStatus: jest.fn(async () => ({ configured: true, reachable: true, ok: true })),
}));
const db = firebaseAdmin.firestore();
const projectId = firebaseAdmin.app().options.projectId!;
const payload = {
  id: 'native-legacy-owned',
  storageFilePath: 'sermons/native-legacy-owned',
  startTime: 0,
  duration: 20,
  deleteOriginal: false,
};
const input = () => ({ firestore: db, projectId, payload });
const control = db.doc('_control/temporalRelease');
const state = db.doc('_control/temporalReleaseState');
const queueEnqueue = jest.fn();
async function freeze(cutoff: unknown = FieldValue.serverTimestamp()) {
  const batch = db.batch();
  batch.update(control, { admission: 'paused', 'domains.media.admission': 'paused', legacyAdmissionCutoff: cutoff });
  batch.set(state, {
    releaseId: 'native-ingress-test',
    mode: 'initial-cutover',
    maximumLegacyExecutionSeconds: 3570,
    legacySettlingCutoff: cutoff,
    compatibilityVerifiedAt: cutoff,
    legacySettlingGraceSeconds: 3600,
  });
  await batch.commit();
}
async function originalFile() {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host)) throw new Error('Dedicated Storage emulator required.');
  const base = `http://${host}/v0/b/urm-app.appspot.com/o`;
  const object = `${base}/${encodeURIComponent(payload.storageFilePath)}`;
  const headers = { Authorization: 'Bearer owner' };
  const upload = await fetch(`${base}?uploadType=media&name=${encodeURIComponent(payload.storageFilePath)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('original-source-bytes'),
  });
  expect(upload.ok).toBe(true);
  const metadata = (await (await fetch(object, { headers })).json()) as {
    bucket: string;
    name: string;
    generation: string;
    timeCreated: string;
  };
  await db.doc(`sermons/${payload.id}`).delete();
  await db.doc(`sermons/${payload.id}`).set({
    uploaderId: 'owner',
    sourceStartTime: 0,
    trimDurationSeconds: 20,
    subtitle: '',
    status: { audioStatus: 'PENDING' },
  });
  return {
    source: {
      kind: 'storage' as const,
      bucket: metadata.bucket,
      path: metadata.name,
      generation: metadata.generation,
      timeCreated: metadata.timeCreated,
    },
    cleanup: async () => {
      expect((await fetch(object, { method: 'DELETE', headers })).ok).toBe(true);
    },
    overwrite: async () => {
      const response = await fetch(`${base}?uploadType=media&name=${encodeURIComponent(payload.storageFilePath)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('replacement-source-bytes'),
      });
      expect(response.ok).toBe(true);
      const current = (await (await fetch(object, { headers })).json()) as typeof metadata;
      return {
        kind: 'storage' as const,
        bucket: current.bucket,
        path: current.name,
        generation: current.generation,
        timeCreated: current.timeCreated,
      };
    },
  };
}
beforeEach(async () => {
  for (const collection of [
    'legacyMediaAdmissions',
    'legacyMediaSourceAdmissions',
    'legacyMediaTaskSourceAdmissions',
    'legacyMediaTasks',
    'legacyAdmissionLeases',
  ])
    await db.recursiveDelete(db.collection(collection));
  await db.doc('_control/temporalProviderUsage').delete();
  await state.delete();
  await control.set({
    schemaVersion: 1,
    revision: 1,
    releaseId: 'native-ingress-test',
    admission: 'open',
    domains: { media: { owner: 'legacy', admission: 'open' } },
  });
  await db.doc(`sermons/${payload.id}`).set({
    uploaderId: 'owner',
    sourceStartTime: 0,
    trimDurationSeconds: 20,
    subtitle: '',
    status: { audioStatus: 'PENDING' },
  });
  await firebaseAdmin.database().ref('processAudioQueues/youtube').remove();
  await firebaseAdmin.database().ref(`processAudioRequests/${payload.id}`).remove();
  queueEnqueue.mockReset();
  setYouTubeTaskQueueFactoryForTesting(() => ({ enqueue: queueEnqueue } as never));
});
afterAll(async () => {
  setYouTubeTaskQueueFactoryForTesting(null);
  await control.delete();
  await state.delete();
  await db.doc(`sermons/${payload.id}`).delete();
  for (const collection of [
    'legacyMediaAdmissions',
    'legacyMediaSourceAdmissions',
    'legacyMediaTaskSourceAdmissions',
    'legacyMediaTasks',
    'legacyAdmissionLeases',
  ])
    await db.recursiveDelete(db.collection(collection));
  await firebaseAdmin.database().ref('processAudioQueues/youtube').remove();
});
it('records a native server admission and exposes active execution to the existing release drain', async () => {
  await prepareLegacyMediaAdmission(input());
  const proof = await db.doc(`legacyMediaAdmissions/${legacyMediaAdmissionId(payload)}`).get();
  expect(proof.get('admittedBefore')).toBeInstanceOf(Timestamp);
  expect(proof.get('admittedBefore').toMillis()).toBeLessThanOrEqual(proof.createTime!.toMillis());
  await withLegacyMediaExecution({ ...input(), taskId: 'task-owned' }, async () => {
    expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'active').get()).size).toBe(1);
  });
  expect((await db.collection('legacyAdmissionLeases').get()).docs[0].get('state')).toBe('completed');
  await withLegacyMediaExecution({ ...input(), taskId: 'task-owned', operation: 'execute' }, async () => undefined);
});
it('rejects fresh admission during pause without trusting old RTDB date strings', async () => {
  await freeze();
  await firebaseAdmin
    .database()
    .ref(`processAudioRequests/${payload.id}`)
    .set({ currentPayload: payload, queuedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' });
  await expect(prepareLegacyMediaAdmission(input())).rejects.toThrow('paused');
  expect((await db.collection('legacyMediaAdmissions').get()).empty).toBe(true);
});
it('allows the same actual admission/task during the native grace and does not renew proof timestamps', async () => {
  await prepareLegacyMediaAdmission(input());
  const ref = db.doc(`legacyMediaAdmissions/${legacyMediaAdmissionId(payload)}`),
    before = await ref.get();
  await withLegacyMediaExecution({ ...input(), taskId: 'task-owned' }, async () => undefined);
  await freeze();
  const now = jest.spyOn(Date, 'now').mockReturnValue(1); // Client clocks do not decide cutoff authorization.
  try {
    await withLegacyMediaExecution({ ...input(), taskId: 'task-owned', operation: 'execute' }, async () => undefined);
  } finally {
    now.mockRestore();
  }
  expect((await ref.get()).updateTime).toEqual(before.updateTime);
});
it('rejects expired grace from the actual Firestore clock even when local clock is old', async () => {
  await prepareLegacyMediaAdmission(input());
  await freeze(Timestamp.fromMillis(1));
  const now = jest.spyOn(Date, 'now').mockReturnValue(1),
    effect = jest.fn();
  try {
    await expect(withLegacyMediaExecution(input(), effect)).rejects.toThrow('window has ended');
  } finally {
    now.mockRestore();
  }
  expect(effect).not.toHaveBeenCalled();
});
it('rejects dispatch and execution after actual Temporal ownership', async () => {
  await prepareLegacyMediaAdmission(input());
  await control.update({ 'domains.media.owner': 'temporal' });
  const effect = jest.fn();
  await expect(withLegacyMediaExecution(input(), effect)).rejects.toThrow('no longer owns');
  expect(effect).not.toHaveBeenCalled();
});
it('requires existing proof and exact immutable task binding, payload and sermon incarnation', async () => {
  const effect = jest.fn();
  await expect(withLegacyMediaExecution(input(), effect)).rejects.toThrow('immutable server admission');
  await prepareLegacyMediaAdmission(input());
  await expect(
    withLegacyMediaExecution({ ...input(), taskId: 'forged', operation: 'execute' }, effect)
  ).rejects.toThrow('dispatched task');
  await withLegacyMediaExecution({ ...input(), taskId: 'owned' }, async () => undefined);
  await expect(
    withLegacyMediaExecution(
      { ...input(), payload: { ...payload, duration: 25 }, taskId: 'owned', operation: 'execute' },
      effect
    )
  ).rejects.toThrow();
  await db.doc(`sermons/${payload.id}`).delete();
  await expect(withLegacyMediaExecution(input(), effect)).rejects.toThrow('incarnation');
  await db.doc(`sermons/${payload.id}`).set({ uploaderId: 'other', status: { audioStatus: 'PENDING' } });
  await expect(withLegacyMediaExecution(input(), effect)).rejects.toThrow('incarnation');
  expect(effect).not.toHaveBeenCalled();
});
it('retains uncertain execution in the permanent drain journal', async () => {
  await prepareLegacyMediaAdmission(input());
  await expect(
    withLegacyMediaExecution(input(), async () => {
      throw new Error('interrupted');
    })
  ).rejects.toThrow('interrupted');
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).size).toBe(1);
});
it('rejects an unproved initial queue while paused before changing RTDB or invoking transport', async () => {
  await freeze();
  await expect(
    queueOrReplaceProcessAudioRequest({
      database: firebaseAdmin.database(),
      payload,
      targetUri: 'https://owned.example/process-audio',
      ownerId: 'fresh-request',
    })
  ).rejects.toThrow('paused');
  expect((await firebaseAdmin.database().ref(`processAudioRequests/${payload.id}`).get()).exists()).toBe(false);
  expect(queueEnqueue).not.toHaveBeenCalled();
});
it('cookie status remains read-only even when a healthy browser and deferred old queue exist under Temporal ownership', async () => {
  await control.update({ 'domains.media.owner': 'temporal', admission: 'paused' });
  const path = firebaseAdmin.database().ref('processAudioQueues/youtube');
  await path.set({
    state: {
      blocked: true,
      blockerReason: 'BROWSER_FALLBACK_UNAVAILABLE',
      probeStatus: 'blocked',
      deferredYouTubeTaskCount: 1,
    },
    deferred: {
      owned: { sermonId: payload.id, payload, requestVersion: 'old', deferredAt: '2000-01-01T00:00:00.000Z' },
    },
  });
  const before = (await path.get()).val();
  await getYouTubeCookieStatus(firebaseAdmin.database());
  expect((await path.get()).val()).toEqual(before);
  expect(queueEnqueue).not.toHaveBeenCalled();
});

it('continues a canonical source admitted before cutoff using its actual tracked source lease', async () => {
  const original = await originalFile();
  await freeze();
  await withLegacyAdmissionLease(
    db,
    {
      projectId,
      domain: 'media',
      actorUid: 'system:firebase-event',
      operation: 'sermonaudiocreatetrigger',
      legacySourceUpload: { sermonId: payload.id, uploaderId: 'owner', sourceStartTime: 0, trimDurationSeconds: 20 },
    },
    async (lease) => {
      await lease.markEffectsStarted();
      await prepareLegacyMediaAdmission({
        ...input(),
        sourceLeaseId: lease.leaseId,
        originalStorageSource: original.source,
        configuredSourceBucket: original.source.bucket,
      });
      await withLegacyMediaExecution({ ...input(), taskId: 'source-continuation' }, async () => undefined);
    }
  );
  expect(
    (await db.collection('legacyAdmissionLeases').where('state', 'in', ['active', 'needs_attention']).get()).empty
  ).toBe(true);
  await original.cleanup();
});
it('blocks source-trigger bumper token writes before admission denial', async () => {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host))
    throw new Error('Dedicated local Storage emulator is required.');
  const base = `http://${host}/v0/b/urm-app.appspot.com/o`;
  const object = `${base}/${encodeURIComponent('intros/default_intro.mp3')}`;
  const headers = { Authorization: 'Bearer owner' };
  const upload = await fetch(`${base}?uploadType=media&name=${encodeURIComponent('intros/default_intro.mp3')}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('owned-test-bumper'),
  });
  expect(upload.ok).toBe(true);
  const before = (await (await fetch(object, { headers })).json()) as { metageneration: string; metadata?: unknown };
  await freeze();
  // A newly created source after the actual cutoff cannot gain a continuation lease.
  await db.doc(`sermons/${payload.id}`).delete();
  await db.doc(`sermons/${payload.id}`).set({
    uploaderId: 'owner',
    sourceStartTime: 0,
    trimDurationSeconds: 20,
    subtitle: '',
    status: { audioStatus: 'PENDING' },
  });
  const snapshot = await db.doc(`sermons/${payload.id}`).get();
  await expect(
    sermonAudioCreateTrigger.run({
      data: snapshot,
      params: { sermonId: payload.id },
      id: 'after-cutoff-source',
    } as Parameters<typeof sermonAudioCreateTrigger.run>[0])
  ).rejects.toMatchObject({ code: 'aborted' });
  const after = (await (await fetch(object, { headers })).json()) as { metageneration: string; metadata?: unknown };
  expect(after.metageneration).toBe(before.metageneration);
  expect(after.metadata).toEqual(before.metadata);
  expect((await fetch(object, { method: 'DELETE', headers })).ok).toBe(true);
});

it('retains an uncertain callback outcome even when an HTTP handler catches its own write failures', async () => {
  await prepareLegacyMediaAdmission(input());
  let artifactEffect = false,
    responseStatus = 200;
  await expect(
    withLegacyMediaExecution({ ...input(), hasUncertainOutcome: () => responseStatus >= 500 }, async () => {
      artifactEffect = true;
      try {
        throw new Error('canonical projection failed');
      } catch {
        try {
          throw new Error('failure settlement failed');
        } catch {
          responseStatus = 500;
        }
      }
    })
  ).rejects.toThrow('not fully settled');
  expect(artifactEffect).toBe(true);
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).size).toBe(1);
});

it('actual native HTTP execution wrapper retains failed artifact/projection settlement while preserving known terminal completion', async () => {
  await prepareLegacyMediaAdmission(input());
  await withLegacyMediaExecution({ ...input(), taskId: 'http-owned' }, async () => undefined);
  const app = express();
  const projectCanonical = jest.fn(async () => {
    throw new Error('canonical projection write failed');
  });
  const settleFailure = jest.fn(async () => {
    throw new Error('canonical failure write failed');
  });
  let artifactEffect = false;
  app.post('/process-audio', async (_request, response) => {
    try {
      await withNativeMediaHttpExecution({ ...input(), taskId: 'http-owned' }, response, async () => {
        artifactEffect = true;
        try {
          await projectCanonical();
        } catch {
          try {
            await settleFailure();
          } catch {
            response.locals.legacySettlementFailed = true;
          }
          response.status(500).json({ error: 'failed after artifact effect' });
        }
      });
    } catch {
      /* A sent response is not sent twice; the lease retains uncertainty. */
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local test port.');
    expect((await fetch(`http://127.0.0.1:${address.port}/process-audio`, { method: 'POST' })).status).toBe(500);
    // Settlement follows the response asynchronously; await the server callback's journal commit.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).empty) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(artifactEffect).toBe(true);
    expect(projectCanonical).toHaveBeenCalledTimes(1);
    expect(settleFailure).toHaveBeenCalledTimes(1);
    expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).size).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  // A completely settled terminal HTTP200/duplicate202 remains successful.
  await withNativeMediaHttpExecution(
    { ...input(), taskId: 'http-owned' },
    { statusCode: 200, locals: {} },
    async () => undefined
  );
  await withNativeMediaHttpExecution(
    { ...input(), taskId: 'http-owned' },
    { statusCode: 202, locals: {} },
    async () => undefined
  );
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'completed').get()).size).toBe(3);
});

it('binds immutable original bytes and rejects a later source overwrite rather than blessing its new generation', async () => {
  const original = await originalFile();
  await freeze();
  const options = {
    projectId,
    domain: 'media',
    actorUid: 'system:firebase-event',
    operation: 'sermonaudiocreatetrigger',
    legacySourceUpload: { sermonId: payload.id, uploaderId: 'owner', sourceStartTime: 0, trimDurationSeconds: 20 },
  };
  const overwritten = await original.overwrite();
  await expect(
    withLegacyAdmissionLease(db, options, async (lease) => {
      await lease.markEffectsStarted();
      return prepareLegacyMediaAdmission({
        ...input(),
        sourceLeaseId: lease.leaseId,
        originalStorageSource: overwritten,
        configuredSourceBucket: overwritten.bucket,
      });
    })
  ).rejects.toThrow('not completed before');
  expect((await db.collection('legacyMediaSourceAdmissions').get()).empty).toBe(true);
  expect((await db.doc(`sermons/${payload.id}`).get()).get('status.audioStatus')).toBe('PENDING');
  await original.cleanup();
});
it('does not renew original authority or permit terminal replay, changed selection or foreign source buckets', async () => {
  const original = await originalFile();
  await freeze();
  await withLegacyAdmissionLease(
    db,
    {
      projectId,
      domain: 'media',
      actorUid: 'system:firebase-event',
      operation: 'sermonaudiocreatetrigger',
      legacySourceUpload: { sermonId: payload.id, uploaderId: 'owner', sourceStartTime: 0, trimDurationSeconds: 20 },
    },
    async (lease) => {
      await lease.markEffectsStarted();
      await expect(
        prepareLegacyMediaAdmission({
          ...input(),
          sourceLeaseId: lease.leaseId,
          originalStorageSource: { ...original.source, bucket: 'foreign' },
          configuredSourceBucket: original.source.bucket,
        })
      ).rejects.toThrow('owned storage object');
      await prepareLegacyMediaAdmission({
        ...input(),
        sourceLeaseId: lease.leaseId,
        originalStorageSource: original.source,
        configuredSourceBucket: original.source.bucket,
      });
    }
  );
  const authority = db.doc(`legacyMediaSourceAdmissions/${legacyMediaAdmissionId(payload)}`),
    before = await authority.get();
  await withLegacyMediaExecution({ ...input(), taskId: 'original-bound' }, async (source) => {
    expect(source).toEqual(original.source);
  });
  await db.doc(`sermons/${payload.id}`).update({ 'status.audioStatus': 'PROCESSING' });
  await withLegacyMediaExecution({ ...input(), taskId: 'original-bound', operation: 'execute' }, async (source) => {
    expect(source).toEqual(original.source);
  });
  expect((await authority.get()).updateTime).toEqual(before.updateTime);
  await db.doc(`sermons/${payload.id}`).update({ sourceStartTime: 1 });
  await expect(withLegacyMediaExecution(input(), async () => undefined)).rejects.toThrow('selection');
  await db.doc(`sermons/${payload.id}`).update({ sourceStartTime: 0, 'status.audioStatus': 'PROCESSED' });
  await expect(withLegacyMediaExecution(input(), async () => undefined)).rejects.toThrow('no longer pending');
  expect((await authority.get()).updateTime).toEqual(before.updateTime);
  await original.cleanup();
});

it.each(['uploader', 'trim-start', 'trim-duration', 'file-to-youtube', 'youtube-to-file', 'youtube-url'])(
  'rejects a stale original source event after its %s changes without source or queue effects',
  async (change) => {
    const wasYouTube = change === 'youtube-to-file' || change === 'youtube-url';
    if (wasYouTube) {
      await db.doc(`sermons/${payload.id}`).delete();
      await db
        .doc(`sermons/${payload.id}`)
        .set({
          uploaderId: 'owner',
          sourceStartTime: 0,
          trimDurationSeconds: 20,
          subtitle: '',
          youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
          status: { audioStatus: 'PENDING' },
        });
    }
    const original = await db.doc(`sermons/${payload.id}`).get();
    await freeze();
    const mutation =
      change === 'uploader'
        ? { uploaderId: 'foreign' }
        : change === 'trim-start'
        ? { sourceStartTime: 1 }
        : change === 'trim-duration'
        ? { trimDurationSeconds: 15 }
        : change === 'youtube-to-file'
        ? { youtubeUrl: FieldValue.delete() }
        : { youtubeUrl: 'https://www.youtube.com/watch?v=lmnopqrstuv' };
    await original.ref.update(mutation);
    const edited = await original.ref.get();
    await expect(
      sermonAudioCreateTrigger.run({
        data: original,
        params: { sermonId: payload.id },
        id: `stale-create-${change}`,
      } as Parameters<typeof sermonAudioCreateTrigger.run>[0])
    ).rejects.toMatchObject({ code: 'aborted' });
    expect((await original.ref.get()).data()).toEqual(edited.data());
    expect((await db.collection('legacyAdmissionLeases').get()).empty).toBe(true);
    expect((await db.collection('legacyMediaAdmissions').get()).empty).toBe(true);
    expect((await db.collection('legacyMediaSourceAdmissions').get()).empty).toBe(true);
    expect((await firebaseAdmin.database().ref(`processAudioRequests/${payload.id}`).get()).exists()).toBe(false);
    expect(queueEnqueue).not.toHaveBeenCalled();
  }
);
