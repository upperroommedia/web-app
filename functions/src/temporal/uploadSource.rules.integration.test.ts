import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { submitServerDurableJob, temporalProjectId } from './bridge';

let environment: RulesTestEnvironment;
const actorUid = 'rules-real-upload-owner';
const bytes = new Uint8Array([1, 2, 3, 4]);

beforeAll(async () => {
  const firestore = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:18081').split(':');
  const storage = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:19199').split(':');
  environment = await initializeTestEnvironment({
    projectId: temporalProjectId(),
    firestore: {
      host: firestore[0], port: Number(firestore[1]),
      rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8'),
    },
    storage: {
      host: storage[0], port: Number(storage[1]),
      rules: readFileSync(resolve(__dirname, '../../../storage.rules'), 'utf8'),
    },
  });
});
afterAll(async () => environment?.cleanup());

it('accepts the real server-admitted source once during pause and preserves every reservation boundary', async () => {
  await environment.clearFirestore();
  await environment.clearStorage();
  const previousMediaOwner = process.env.TASK_ORCHESTRATOR_MEDIA;
  process.env.TASK_ORCHESTRATOR_MEDIA = 'temporal';
  try {
    try {
      await firebaseAdmin.auth().deleteUser(actorUid);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    }
    await firebaseAdmin.auth().createUser({ uid: actorUid });
    await firebaseAdmin.auth().setCustomUserClaims(actorUid, { role: 'uploader' });
    const db = firebaseAdmin.firestore();
    await db.doc('_control/temporalRelease').set({
      schemaVersion: 1, revision: 1, admission: 'open', releaseId: 'rules-real-upload',
      domains: { media: { owner: 'temporal', admission: 'open' } }, updatedAt: Date.now(),
    });
    await db.doc('_control/temporalProviderUsage').set({
      schemaVersion: 1, projectId: temporalProjectId(), epoch: 'rules-real-upload', status: 'ready',
      releaseId: 'rules-real-upload', controlRevision: 1,
    });
    // Exercise production admission, not a hand-authored projection with a copied kind string.
    const receipt = await submitServerDurableJob({
      actorUid, requestId: 'rules-real-upload', kind: 'upload.create',
      entity: { type: 'sermon', id: 'client-placeholder' },
      payload: {
        sermon: { title: 'Real admission Storage rules regression' },
        source: { type: 'file', name: 'source.mp3', size: bytes.length, lastModified: 1000,
          fingerprint: { algorithm: 'sha256-chunks-v1', chunkBytes: 4194304, value: 'a'.repeat(64) } },
        trimStart: 0, duration: 60,
      },
    });
    expect(receipt.admissionState).toBe('awaiting_source');
    expect(receipt.sourceUpload).toBeDefined();
    const source = receipt.sourceUpload!;
    const projection = await db.doc(`durableJobs/${receipt.jobId}`).get();
    expect(projection.get('result.sourceUpload')).toEqual(source);
    expect(projection.get('requestedBy')).toBe(actorUid);
    expect(source.expectedFile.size).toBe(bytes.length);
    await db.doc('_control/temporalRelease').update({ admission: 'paused', revision: 2 });

    const owner = environment.authenticatedContext(actorUid, { role: 'uploader' });
    const other = environment.authenticatedContext('rules-real-upload-other', { role: 'uploader' });
    const admin = environment.authenticatedContext('rules-real-upload-admin', { role: 'admin' });
    const metadata = { customMetadata: { durableJobId: receipt.jobId } };
    // Fresh references for rejected uploads avoid reusing a failed SDK upload task.
    await assertFails(Promise.resolve(other.storage().ref(source.storagePath).put(bytes, metadata)));
    await assertFails(Promise.resolve(owner.storage().ref(source.storagePath).put(new Uint8Array([1]), metadata)));
    await assertFails(Promise.resolve(owner.storage().ref(source.storagePath).put(bytes, {
      customMetadata: { durableJobId: 'unrelated-reservation' },
    })));
    await assertFails(Promise.resolve(owner.storage().ref(source.storagePath + '-other').put(bytes, metadata)));
    await projection.ref.update({ state: 'queued' });
    await assertFails(Promise.resolve(owner.storage().ref(source.storagePath).put(bytes, metadata)));
    await projection.ref.update({ state: 'awaiting_source' });
    await assertSucceeds(Promise.resolve(owner.storage().ref(source.storagePath).put(bytes, metadata)));
    await assertSucceeds(owner.storage().ref(source.storagePath).getMetadata());
    await assertSucceeds(admin.storage().ref(source.storagePath).getMetadata());
    await assertFails(other.storage().ref(source.storagePath).getMetadata());
    await assertFails(environment.unauthenticatedContext().storage().ref(source.storagePath).getMetadata());
    await assertFails(Promise.resolve(owner.storage().ref(source.storagePath).put(bytes, metadata)));
    await assertFails(owner.storage().ref(source.storagePath).updateMetadata({ contentType: 'audio/mpeg' }));
    await assertFails(owner.storage().ref(source.storagePath).delete());
  } finally {
    if (previousMediaOwner === undefined) delete process.env.TASK_ORCHESTRATOR_MEDIA;
    else process.env.TASK_ORCHESTRATOR_MEDIA = previousMediaOwner;
  }
});
