/** Real Firestore transactions and Storage streams; no provider network requests or fake datastore. */
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { getApps, deleteApp } from 'firebase-admin/app';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => {
  const { getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');
  const app =
    getApps().find((item: any) => item.name === 'provider-sandbox-integration') ??
    initializeApp(
      { projectId: 'urm-app-staging', storageBucket: 'urm-app-staging.firebasestorage.app' },
      'provider-sandbox-integration'
    );
  return {
    __esModule: true,
    default: { app: () => app, firestore: () => getFirestore(app), storage: () => getStorage(app) },
  };
});
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import { STAGING_SANDBOX_PROFILE, sandboxProfileDocumentPath } from './profile';
import { DURABLE_COLLECTIONS, durableEntityKey } from '@upperroom/orchestration/job-store';
import {
  handleSandboxRequest,
  uploadSandboxAllocation,
  probeSandboxMedia,
  createSandboxSoundCloudTrack,
  updateSandboxSoundCloudTrack,
  inspectSandboxJob,
} from './service';
import { sandboxResourceKey, beginSandboxAssetPreparation, completeSandboxAssetPreparation } from './store';
import { resolveStageAsset, inspectStageAsset, inspectReviewedSandboxWav, copyStageAssetToSandbox } from './assets';
import { createListRow, getFullListRowsWithTotal, getListDetails } from '../helpers/addToListHelpers';
import { authenticateSubsplash } from '../subsplashUtils';
import { normalizeSubsplashListPatchAck } from '../helpers/subsplashMutationAck';
import type { ProviderSimulationScenario } from '@upperroom/contracts/temporal';
const profile = STAGING_SANDBOX_PROFILE;
const db = () => admin.firestore(),
  root = () => db().doc(sandboxProfileDocumentPath(profile));
const ownedJobs: string[] = [];
let priorMode: string | undefined;
function wave20Seconds(): Buffer {
  const sampleRate = 8000,
    frames = 20 * sampleRate,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 8000), 44 + i * 2);
  return bytes;
}
const request = (path: string, method = 'GET', data?: unknown, jobId?: string) =>
  handleSandboxRequest(profile, {
    provider: 'subsplash',
    url: 'https://core.subsplash.com' + path,
    method,
    data,
    ...(jobId ? { context: { jobId, sourceStepIds: ['provider-create'] } } : {}),
  });
async function job(scenario: ProviderSimulationScenario): Promise<string> {
  const id = 'sandbox-test-' + randomUUID(),
    entity = { type: 'sermon' as const, id },
    kind = 'sermon.publish' as const,
    pin = { mode: 'sandbox', profileId: profile.profileId, version: 1, scenario };
  const batch = db().batch();
  batch.create(db().collection(DURABLE_COLLECTIONS.intents).doc(id), {
    projectId: profile.projectId,
    jobId: id,
    generation: 1,
    kind,
    entity,
    payload: { providerExecution: pin },
  });
  batch.create(db().collection(DURABLE_COLLECTIONS.jobs).doc(id), {
    projectId: profile.projectId,
    jobId: id,
    generation: 1,
    kind,
    entity,
    state: 'running',
    providerExecution: pin,
  });
  batch.set(db().collection(DURABLE_COLLECTIONS.entities).doc(durableEntityKey(profile.projectId, entity, kind)), {
    generation: 1,
    activeJobId: id,
  });
  await batch.commit();
  ownedJobs.push(id);
  return id;
}
beforeAll(async () => {
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'])
    if (!/^(127\.0\.0\.1|localhost):[1-9][0-9]*$/.test(process.env[name] ?? '') || process.env[name]?.endsWith(':9'))
      throw new Error('Dedicated Firebase emulator harness is required');
  priorMode = process.env.STAGING_PROVIDER_MODE;
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  console.info('sandbox emulator: exact SDK app/project', admin.app().options.projectId);
  await db().recursiveDelete(root());
  console.info('sandbox emulator: clean namespace ready');
  await root().set({
    state: 'ready',
    profile,
    catalogImportId: 'emulator-owned-test-fixture',
    sourceDigest: 'a'.repeat(64),
    resourceCount: 0,
  });
}, 45000);
afterAll(async () => {
  await db().recursiveDelete(root());
  for (const id of ownedJobs) {
    await db().collection(DURABLE_COLLECTIONS.intents).doc(id).delete();
    await db().collection(DURABLE_COLLECTIONS.jobs).doc(id).delete();
    await db()
      .collection(DURABLE_COLLECTIONS.entities)
      .doc(durableEntityKey(profile.projectId, { type: 'sermon', id }, 'sermon.publish'))
      .delete();
  }
  if (priorMode === undefined) delete process.env.STAGING_PROVIDER_MODE;
  else process.env.STAGING_PROVIDER_MODE = priorMode;
  await admin.firestore().terminate();
  const app = getApps().find((item) => item.name === 'provider-sandbox-integration');
  if (app) await deleteApp(app);
}, 45000);
it('atomically consumes one transient failure across concurrent actual Firestore transactions', async () => {
  const id = await job('transient-failure');
  const allocated = await request('/files/v1/audios', 'POST', { title: 'parallel' }, id);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => request('/files/v1/audios/' + allocated.data.id, 'GET', undefined, id))
  );
  expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
  expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(3);
  const plans = await root().collection('faultPlans').where('jobId', '==', id).get();
  expect(plans.size).toBe(1);
  expect(plans.docs[0].get('remaining')).toBe(0);
  const journals = await root().collection('requests').where('jobId', '==', id).get();
  expect(journals.size).toBe(5);
  expect(journals.docs.filter((row) => row.get('outcome') === 'rejected-before-effect')).toHaveLength(1);
});
it('persists committed lost acknowledgements and never turns a repeated POST into invented idempotency', async () => {
  const id = await job('commit-then-lost-response');
  await expect(request('/files/v1/audios', 'POST', { title: id }, id)).rejects.toMatchObject({ code: 'ECONNRESET' });
  const before = (await root().collection('requests').where('jobId', '==', id).get()).size;
  const evidence = await inspectSandboxJob(profile, id);
  expect(evidence.resources).toHaveLength(1);
  expect(evidence.requests[0].outcome).toBe('committed-response-lost');
  expect(evidence.requests[0].resourceRefs[0].id).toBe(evidence.resources[0].id);
  expect((await root().collection('requests').where('jobId', '==', id).get()).size).toBe(before);
  expect(JSON.stringify(evidence)).not.toMatch(/file_name|Authorization|storage\.googleapis/);
  let rows = await root().collection('resources').where('family', '==', 'audios').get();
  expect(rows.docs.filter((row) => row.get('body.title') === id)).toHaveLength(1);
  await request('/files/v1/audios', 'POST', { title: id }, id);
  rows = await root().collection('resources').where('family', '==', 'audios').get();
  expect(rows.docs.filter((row) => row.get('body.title') === id)).toHaveLength(2);
});
it('rejects stale generation, altered profile and unseeded identities without provider effects', async () => {
  const id = await job('success');
  await db().collection(DURABLE_COLLECTIONS.jobs).doc(id).update({ generation: 2 });
  await expect(request('/files/v1/audios', 'POST', { title: 'stale' }, id)).rejects.toThrow('generation');
  await expect(
    handleSandboxRequest(
      { ...profile, projectId: 'urm-app' as any },
      { provider: 'subsplash', method: 'GET', url: 'https://core.subsplash.com/files/v1/audios' }
    )
  ).rejects.toThrow();
  await expect(request('/files/v1/audios/unseeded-' + randomUUID())).rejects.toMatchObject({
    response: { status: 404 },
  });
});
it('uses actual staging Storage bytes for image allocation, transcode, playback readiness and memberships', async () => {
  const id = await job('success'),
    bucket = admin.storage().bucket('urm-app-staging.firebasestorage.app');
  const audioPath = `_providerSandbox/${profile.profileId}/tests/${id}.wav`,
    audioBytes = wave20Seconds();
  const source = bucket.file(audioPath);
  await source.save(audioBytes, { metadata: { contentType: 'audio/wav', metadata: { duration: '20' } } });
  const asset = await resolveStageAsset(profile, audioPath, bucket.name);
  await root().update({
    fixture: {
      ...asset,
      size: audioBytes.length,
      sha256: createHash('sha256').update(audioBytes).digest('hex'),
      contentType: 'audio/wav',
      durationSeconds: 20,
    },
  });
  expect((await inspectStageAsset(profile, asset)).size).toBe(audioBytes.length);
  const image = await request(
    '/files/v1/images',
    'POST',
    { content_type: 'image/png', title: 'fixture', type: 'square' },
    id
  );
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
    'hex'
  );
  await uploadSandboxAllocation(
    profile,
    image.data._links.presigned_upload_url.href,
    Readable.from([png]),
    { contentType: 'image/png', contentLength: png.length },
    { jobId: id, sourceStepIds: ['image-upload'] }
  );
  const audio = await request('/files/v1/audios', 'POST', { title: 'fixture' }, id);
  const transcode = await request(
    '/transcoder/v1/jobs',
    'POST',
    {
      file_name: `https://storage.googleapis.com/${bucket.name}/${audioPath}?generation=${asset.generation}`,
      _embedded: { audio: { id: audio.data.id } },
    },
    id
  );
  await source.delete();
  expect(transcode.data.status).toBe('processing');
  await new Promise((resolve) => setTimeout(resolve, 550));
  const output = (await request('/files/v1/audios/' + audio.data.id)).data._embedded['audio-outputs'][0];
  expect((await probeSandboxMedia(profile, output._links.download.href, { maxBytes: 1024 })).ok).toBe(true);
  const media = await request(
    '/media/v1/media-items',
    'POST',
    {
      title: 'fixture',
      auto_publish: true,
      tags: ['speaker:Sandbox Speaker'],
      _embedded: { audio: { id: audio.data.id }, images: [{ id: image.data.id, type: 'square' }] },
    },
    id
  );
  const series = await request('/media/v1/media-series', 'POST', { title: 'fixture' }, id);
  await request(
    '/media/v1/media-items/' + media.data.id,
    'PATCH',
    { _embedded: { 'media-series': { id: series.data.id } } },
    id
  );
  await request(
    '/media/v1/media-series/' + series.data.id,
    'PATCH',
    { _embedded: { 'media-items': [{ id: media.data.id, position: 3 }] } },
    id
  );
  expect(
    (await request('/media/v1/media-items?filter[media_series]=' + series.data.id)).data._embedded['media-items'][0]
      .position
  ).toBe(3);
  const list = await request('/builder/v1/lists', 'POST', { title: 'fixture' }, id);
  const patched = await request(
    '/builder/v1/lists/' + list.data.id,
    'PATCH',
    { _embedded: { 'list-rows': [createListRow({ id: media.data.id, type: 'media-item' }, list.data.id, 1)] } },
    id
  );
  expect(
    normalizeSubsplashListPatchAck(patched.data, list.data.id)?._embedded['list-rows'][0]._embedded?.['media-item']?.id
  ).toBe(media.data.id);
  const token = await authenticateSubsplash();
  const consumed = await getFullListRowsWithTotal(list.data.id, token);
  expect(consumed.total).toBe(1);
  expect(consumed.rows[0].id).toBe(patched.data._embedded['list-rows'][0].id);
  expect((await getListDetails(list.data.id, token)).list_rows_count).toBe(1);
  expect(
    (await request('/tags/v1/tags?filter[type]=speaker')).data._embedded.tags.some(
      (tag: any) => tag.title === 'Sandbox Speaker'
    )
  ).toBe(true);
  await request('/media/v1/media-items/' + media.data.id, 'DELETE', undefined, id);
  await expect(request('/media/v1/media-items/' + media.data.id)).rejects.toMatchObject({ response: { status: 404 } });
  const stored = (
    await root().collection('resources').doc(sandboxResourceKey('subsplash', 'media-items', media.data.id)).get()
  ).data();
  expect(stored?.deleted).toBe(true);
});
it('creates, updates, probes and deletes SoundCloud tracks using private real Storage generations', async () => {
  const id = await job('success'),
    bucket = admin.storage().bucket('urm-app-staging.firebasestorage.app'),
    path = `_providerSandbox/${profile.profileId}/tests/${id}.wav`;
  await root()
    .collection('resources')
    .doc(sandboxResourceKey('soundcloud', 'accounts', '9000000000001'))
    .set({
      schemaVersion: 1,
      provider: 'soundcloud',
      family: 'accounts',
      id: '9000000000001',
      revision: 1,
      deleted: false,
      body: { id: 9000000000001, id_str: '9000000000001', urn: 'soundcloud:users:9000000000001' },
      createdAtMillis: Date.now(),
      updatedAtMillis: Date.now(),
    });
  const file = bucket.file(path);
  await file.save(wave20Seconds(), { metadata: { contentType: 'audio/wav', metadata: { duration: '20' } } });
  const audio = await resolveStageAsset(profile, path, bucket.name),
    context = { jobId: id, sourceStepIds: ['soundcloud'] };
  const created = await createSandboxSoundCloudTrack(
    profile,
    { audio, metadata: { title: 'SoundCloud fixture', streamable: false, artist: 'fixture artist' } },
    context
  );
  expect(created.data.user.id).toBe(9000000000001);
  await file.delete();
  const updated = await updateSandboxSoundCloudTrack(
    profile,
    { trackId: created.data.urn, metadata: { title: 'Edited fixture' } },
    context
  );
  expect(updated.data.title).toBe('Edited fixture');
  await new Promise((resolve) => setTimeout(resolve, 550));
  const trackUrl = 'https://api.soundcloud.com/tracks/' + encodeURIComponent(created.data.urn);
  const track = await handleSandboxRequest(profile, { provider: 'soundcloud', method: 'GET', url: trackUrl });
  expect(track.data.streamable).toBe(false);
  expect(track.data.state).toBe('finished');
  const streams = await handleSandboxRequest(profile, {
    provider: 'soundcloud',
    method: 'GET',
    url: trackUrl + '/streams',
  });
  expect((await probeSandboxMedia(profile, streams.data.hls_aac_160_url, { maxBytes: 1024 })).ok).toBe(true);
  await handleSandboxRequest(profile, { provider: 'soundcloud', method: 'DELETE', url: trackUrl, context });
  await expect(
    handleSandboxRequest(profile, { provider: 'soundcloud', method: 'GET', url: trackUrl })
  ).rejects.toMatchObject({ response: { status: 404 } });
});

it('keeps planned permanent rejection across real SDK attempts without committing resource mutations', async () => {
  const id = await job('permanent-failure');
  for (let attempt = 0; attempt < 2; attempt += 1)
    await expect(request('/files/v1/audios', 'POST', { title: id }, id)).rejects.toMatchObject({
      response: { status: 403 },
    });
  const evidence = await inspectSandboxJob(profile, id);
  expect(evidence.requests).toHaveLength(2);
  expect(evidence.resources).toEqual([]);
  expect(evidence.requests.every((row) => row.outcome === 'rejected-before-effect')).toBe(true);
});

async function ownedCopyFixture(jobId: string) {
  const bucket = admin.storage().bucket('urm-app-staging.firebasestorage.app'),
    path = `_providerSandbox/${profile.profileId}/tests/${jobId}.wav`,
    bytes = wave20Seconds(),
    file = bucket.file(path);
  await file.save(bytes, { resumable: false, metadata: { contentType: 'audio/wav' } });
  const ref = await resolveStageAsset(profile, path, bucket.name);
  const evidence = await inspectReviewedSandboxWav(profile, ref, {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    durationSeconds: 20,
  });
  return { bucket, file, bytes, evidence, context: { jobId, sourceStepIds: ['bounded-copy'] } };
}
it('bounds private storage across repeated permanent rejection while retaining truthful provider failures', async () => {
  const id = await job('permanent-failure'),
    fixture = await ownedCopyFixture(id),
    input = { audio: fixture.evidence, metadata: { title: id } };
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(createSandboxSoundCloudTrack(profile, input, fixture.context)).rejects.toMatchObject({
      response: { status: 403 },
    });
  const preparations = await root().collection('preparedAssets').where('jobId', '==', id).get();
  expect(preparations.size).toBe(1);
  const preparation = preparations.docs[0].data();
  expect(preparation.state).toBe('retained');
  const [objects] = await fixture.bucket.getFiles({
    prefix: preparation.target.path,
    maxResults: 2,
    autoPaginate: false,
  });
  expect(objects).toHaveLength(1);
  expect(preparation.target.preparationId).toBe(preparations.docs[0].id);
  expect((await inspectSandboxJob(profile, id)).resources).toEqual([]);
  await fixture.file.delete();
});
it('measures the unadapted Storage emulator create-only capability using exact owned bytes', async () => {
  const bucket = admin.storage().bucket('urm-app-staging.firebasestorage.app'),
    file = bucket.file(`_providerSandbox/${profile.profileId}/tests/cas-capability-${randomUUID()}`),
    first = Buffer.from('owned first create-only capability payload'),
    second = Buffer.from('owned second create-only capability payload');
  try {
    await file.save(first, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    const firstGeneration = String((await file.getMetadata())[0].generation);
    // Current Firebase Storage emulator ignores this precondition. A future implementation may enforce it.
    let rejected = false;
    try {
      await file.save(second, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (error) {
      expect(error).toMatchObject({ code: 412 });
      rejected = true;
    }
    expect((await file.download())[0]).toEqual(rejected ? first : second);
    if (rejected) expect(String((await file.getMetadata())[0].generation)).toBe(firstGeneration);
    else
      console.info('Storage emulator lacks atomic ifGenerationMatch:0; concurrency test supplies only that contract');
  } finally {
    await file.delete({ ignoreNotFound: true });
  }
});
it('shares one private copy with an explicit GCS create-only test boundary and rejects stale retries', async () => {
  const id = await job('success'),
    fixture = await ownedCopyFixture(id),
    key = createHash('sha256')
      .update(
        JSON.stringify([
          profile.profileId,
          id,
          fixture.evidence.bucket,
          fixture.evidence.path,
          fixture.evidence.generation,
          fixture.evidence.sha256,
        ])
      )
      .digest('hex'),
    targetPath = `_providerSandbox/${profile.profileId}/media/${key}/asset`,
    prototype: typeof fixture.file = Object.getPrototypeOf(fixture.file),
    nativeCreateWriteStream = prototype.createWriteStream;
  let arrivals = 0,
    releaseContenders!: () => void,
    failContenders!: (error: Error) => void,
    finishWinner!: () => void,
    failWinner!: (error: Error) => void,
    failure: Error | undefined;
  const streams = new Set<Writable>(),
    allContenders = new Promise<void>((resolve, reject) => {
      releaseContenders = resolve;
      failContenders = reject;
    }),
    winnerFinished = new Promise<void>((resolve, reject) => {
      finishWinner = resolve;
      failWinner = reject;
    });
  // Install rejection handlers immediately, including when a source fails before any stream is allocated.
  void allContenders.catch(() => undefined);
  void winnerFinished.catch(() => undefined);
  const abort = (cause: unknown) => {
    if (failure) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    failContenders(failure);
    failWinner(failure);
    for (const stream of streams) stream.destroy(failure);
  };
  const barrierTimer = setTimeout(() => abort(new Error('Concurrent copy test barrier exceeded 10 seconds')), 10000);
  barrierTimer.unref();
  // Supply ONLY the atomic create-only condition absent from Firebase's emulator. The first writer still
  // streams real source bytes into actual Storage; all callers use actual Firestore and recovery reads.
  const adapter = jest
    .spyOn(prototype, 'createWriteStream')
    .mockImplementation(function (
      this: typeof fixture.file,
      options?: Parameters<typeof fixture.file.createWriteStream>[0]
    ) {
      if (this.name !== targetPath || this.bucket.name !== fixture.bucket.name)
        return nativeCreateWriteStream.call(this, options);
      expect(options?.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
      const winner = ++arrivals === 1;
      if (arrivals === 3) {
        clearTimeout(barrierTimer);
        releaseContenders();
      }
      const output = winner ? nativeCreateWriteStream.call(this, options) : undefined;
      if (output) {
        streams.add(output);
        output.once('finish', finishWinner);
        output.once('error', abort);
      }
      const boundary = new Writable({
        write(chunk, encoding, done) {
          if (output) output.write(chunk, encoding, done);
          else done();
        },
        final(done) {
          if (output) {
            void allContenders.then(() => {
              output.end();
              void winnerFinished.then(() => done(), done);
            }, done);
          } else {
            void winnerFinished.then(
              () => done(Object.assign(new Error('GCS create-only precondition'), { code: 412 })),
              done
            );
          }
        },
        destroy(error, done) {
          if (output && !output.destroyed) output.destroy(error ?? undefined);
          done(error);
        },
      });
      streams.add(boundary);
      if (failure) queueMicrotask(() => boundary.destroy(failure));
      return boundary;
    });
  try {
    // Every failure aborts peers; settle all of them before restoring the native boundary.
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        copyStageAssetToSandbox(profile, fixture.evidence, fixture.context).catch((error: unknown) => {
          abort(error);
          throw error;
        })
      )
    );
    const copies = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(arrivals).toBe(3);
    expect(new Set(copies.map((row) => row.path + ':' + row.generation)).size).toBe(1);
    const preparations = await root().collection('preparedAssets').where('jobId', '==', id).get();
    expect(preparations.size).toBe(1);
    const stored = preparations.docs[0].data().target;
    expect(stored).toMatchObject({
      sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
      size: fixture.bytes.length,
    });
    expect((await fixture.bucket.file(copies[0].path).download())[0]).toEqual(fixture.bytes);
    // A changed target remains a hard conflict; emulator adaptation never weakens the durable identity gate.
    for (const changed of [
      { generation: copies[0].generation + '1' },
      { sha256: '0'.repeat(64) },
      { size: copies[0].size + 1 },
    ])
      await expect(
        completeSandboxAssetPreparation(profile, preparations.docs[0].id, { ...copies[0], ...changed })
      ).rejects.toThrow('Private asset target identity changed');
    expect((await preparations.docs[0].ref.get()).get('target')).toEqual(stored);
    await db().collection(DURABLE_COLLECTIONS.jobs).doc(id).update({ generation: 2 });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(copyStageAssetToSandbox(profile, fixture.evidence, fixture.context)).rejects.toThrow('generation');
    expect(arrivals).toBe(3);
    const [objects] = await fixture.bucket.getFiles({ prefix: copies[0].path, maxResults: 2, autoPaginate: false });
    expect(objects).toHaveLength(1);
    expect(String((await objects[0].getMetadata())[0].generation)).toBe(copies[0].generation);
  } finally {
    clearTimeout(barrierTimer);
    for (const stream of streams) {
      if (!stream.destroyed) stream.destroy();
      stream.removeListener('finish', finishWinner);
      stream.removeListener('error', abort);
    }
    adapter.mockRestore();
    await fixture.file.delete();
  }
});
it('recovers a real uploaded but unacknowledged private preparation while preserving nonidempotent provider POSTs', async () => {
  const id = await job('commit-then-lost-response'),
    fixture = await ownedCopyFixture(id),
    origin = fixture.evidence;
  const key = createHash('sha256')
      .update(JSON.stringify([profile.profileId, id, origin.bucket, origin.path, origin.generation, origin.sha256]))
      .digest('hex'),
    path = `_providerSandbox/${profile.profileId}/media/${key}/asset`;
  const preparation = await beginSandboxAssetPreparation(profile, fixture.context, path, origin),
    target = fixture.bucket.file(path);
  // Crash fixture: bytes reached Storage, but the durable preparation has no completion acknowledgement.
  await target.save(fixture.bytes, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: 'audio/wav',
      metadata: { sandboxProfileId: profile.profileId, preparationId: preparation.id },
    },
  });
  const generation = String((await target.getMetadata())[0].generation);
  expect((await root().collection('preparedAssets').doc(preparation.id).get()).get('state')).toBe('preparing');
  const recovered = await copyStageAssetToSandbox(profile, origin, fixture.context);
  expect(recovered.generation).toBe(generation);
  expect(recovered.sha256).toBe(origin.sha256);
  const input = { audio: origin, metadata: { title: id } };
  await expect(createSandboxSoundCloudTrack(profile, input, fixture.context)).rejects.toMatchObject({
    code: 'ECONNRESET',
  });
  const first = (await inspectSandboxJob(profile, id)).resources[0];
  const second = await createSandboxSoundCloudTrack(profile, input, fixture.context);
  expect(second.data.id).not.toBe(first.id);
  const journals = await inspectSandboxJob(profile, id);
  expect(journals.resources).toHaveLength(2);
  expect((await root().collection('preparedAssets').where('jobId', '==', id).get()).size).toBe(1);
  const [objects] = await fixture.bucket.getFiles({ prefix: path, maxResults: 2, autoPaginate: false });
  expect(objects).toHaveLength(1);
  await fixture.file.delete();
});
