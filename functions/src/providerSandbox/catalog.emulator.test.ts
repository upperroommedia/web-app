/** Dedicated firebase.test.json only. Exercises actual Firestore native CAS and generation-pinned staging Storage. */
import { randomUUID, createHash } from 'node:crypto';
import { getApps, deleteApp } from 'firebase-admin/app';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => {
  const { getApps, initializeApp } = require('firebase-admin/app'),
    { getFirestore } = require('firebase-admin/firestore'),
    { getStorage } = require('firebase-admin/storage');
  const app =
    getApps().find((item: any) => item.name === 'provider-sandbox-catalog-test') ??
    initializeApp(
      { projectId: 'urm-app-staging', storageBucket: 'urm-app-staging.firebasestorage.app' },
      'provider-sandbox-catalog-test'
    );
  return {
    __esModule: true,
    default: { app: () => app, firestore: () => getFirestore(app), storage: () => getStorage(app) },
  };
});
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import { STAGING_SANDBOX_PROFILE, sandboxProfileDocumentPath, assertSandboxCatalogReady } from './profile';
import {
  applySandboxCatalogPlan,
  readSandboxCatalogSources,
  buildSandboxCatalogPlan,
  catalogDigest,
  inspectSandboxCatalogFixture,
} from './catalog';
const profile = STAGING_SANDBOX_PROFILE,
  db = () => admin.firestore(),
  root = () => db().doc(sandboxProfileDocumentPath(profile));
const controlPath = '_control/temporalRelease',
  statePath = '_control/temporalReleaseState',
  opPath = '_control/temporalReleaseOperation';
const owner = {
  releaseId: randomUUID(),
  revision: 23,
  operationId: randomUUID(),
  operator: 'emulator-operator@example.test',
};
const sermonId = 'sandbox-catalog-' + randomUUID(),
  sermonPath = `sermons/${sermonId}`,
  fixturePath = `_providerSandbox/${profile.profileId}/catalog-fixture-${randomUUID()}.wav`;
const prior = new Map<string, unknown>(),
  preserve = [
    controlPath,
    statePath,
    opPath,
    '_control/temporalProviderUsage',
    '_control/temporalReleaseHistory-sandbox-test',
  ];
let fixture: any;
const controls = () => ({
  schemaVersion: 1,
  releaseId: owner.releaseId,
  revision: 23,
  admission: 'paused',
  domains: Object.fromEntries(
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
      domain,
      { owner: 'temporal', admission: domain === 'search' ? 'paused' : 'open' },
    ])
  ),
});
// Deterministic 20-second, 8kHz mono PCM16 signal. Integer samples keep its digest portable across hosts.
function createCatalogWavFixture(): Buffer {
  const sampleRate = 8000,
    frameCount = sampleRate * 20,
    dataLength = frameCount * 2;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataLength, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataLength, 40);
  for (let frame = 0; frame < frameCount; frame++) bytes.writeInt16LE(((frame % 200) - 100) * 128, 44 + frame * 2);
  return bytes;
}
const fixtureSha256 = 'f2b223ef6cabad1917d0415ede3adfa58c8261fb545b984ee08f4baa3e07b5e3';
beforeAll(async () => {
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'])
    if (!/^(127\.0\.0\.1|localhost):[1-9][0-9]*$/.test(process.env[name] ?? '') || process.env[name]?.endsWith(':9'))
      throw new Error('Dedicated Firebase emulator harness required');
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  for (const path of preserve) {
    const snapshot = await db().doc(path).get();
    prior.set(path, snapshot.exists ? snapshot.data() : undefined);
  }
  const bytes = createCatalogWavFixture();
  expect(bytes.length).toBe(320044);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixtureSha256);
  await admin
    .storage()
    .bucket()
    .file(fixturePath)
    .save(bytes, { resumable: false, metadata: { contentType: 'audio/wav', metadata: { duration: '20' } } });
  const [metadata] = await admin.storage().bucket().file(fixturePath).getMetadata();
  fixture = await inspectSandboxCatalogFixture(profile, {
    bucket: 'urm-app-staging.firebasestorage.app',
    path: fixturePath,
    generation: String(metadata.generation),
    sha256: fixtureSha256,
    size: 320044,
    durationSeconds: 20,
  });
  expect(fixture.durationSeconds).toBe(20);
}, 90000);
beforeEach(async () => {
  await db().recursiveDelete(root());
  await db().doc(opPath).delete();
  await db()
    .doc(sermonPath)
    .set({
      title: 'Original stage catalog',
      subsplashId: 'catalog-alias-' + sermonId,
      soundCloudTrackId: 'soundcloud:tracks:900123',
    });
  await db().doc(controlPath).set(controls());
  await db().doc(statePath).set({ releaseId: owner.releaseId, controlRevision: 23, phase: 'ui-frozen' });
  await db()
    .doc('_control/temporalProviderUsage')
    .set({ epoch: 'existing-epoch', status: 'ready', sentinel: 'untouched' });
  await db().doc('_control/temporalReleaseHistory-sandbox-test').set({ sentinel: 'immutable-original-history' });
});
afterAll(async () => {
  await db().recursiveDelete(root());
  await db().doc(sermonPath).delete();
  await db().collection('durableJobs').doc('sandbox-preprofile-job').delete();
  for (const path of preserve) {
    if (prior.get(path) === undefined) await db().doc(path).delete();
    else
      await db()
        .doc(path)
        .set(prior.get(path) as any);
  }
  await admin.storage().bucket().file(fixturePath).delete({ ignoreNotFound: true });
  await db().terminate();
  for (const app of getApps().filter((item) => item.name === 'provider-sandbox-catalog-test')) await deleteApp(app);
  delete process.env.STAGING_PROVIDER_MODE;
}, 90000);
async function plan() {
  return buildSandboxCatalogPlan(profile, await readSandboxCatalogSources(db()), fixture, Date.now());
}
test('actual private import preserves canonical versions, existing epoch/history, and produces exact ready/audit evidence', async () => {
  const before = await db().doc(sermonPath).get(),
    usage = (await db().doc('_control/temporalProviderUsage').get()).data(),
    history = (await db().doc('_control/temporalReleaseHistory-sandbox-test').get()).data();
  const expected = await plan(),
    result = await applySandboxCatalogPlan(db(), expected, owner);
  expect(result.resourceCount).toBe(expected.resources.length);
  const marker = (await root().get()).data();
  assertSandboxCatalogReady(profile, marker);
  expect((await root().collection('catalogImports').doc(expected.importId).get()).get('providerNetworkRequests')).toBe(
    0
  );
  const after = await db().doc(sermonPath).get();
  expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  expect(after.data()).toEqual(before.data());
  expect((await db().doc('_control/temporalProviderUsage').get()).data()).toEqual(usage);
  expect((await db().doc('_control/temporalReleaseHistory-sandbox-test').get()).data()).toEqual(history);
  expect((await db().doc(opPath).get()).exists).toBe(false);
  expect((await db().doc(controlPath).get()).get('revision')).toBe(23);
});
test('actual pre-profile active provider job prevents any import activation or owned lock acquisition', async () => {
  const expected = await plan();
  await db().collection('durableJobs').doc('sandbox-preprofile-job').set({ kind: 'sermon.publish', state: 'retrying' });
  await expect(applySandboxCatalogPlan(db(), expected, owner)).rejects.toThrow('NONTERMINAL');
  expect((await root().get()).exists).toBe(false);
  expect((await db().doc(opPath).get()).exists).toBe(false);
  await db().collection('durableJobs').doc('sandbox-preprofile-job').delete();
});
test('actual native source race retains incomplete namespace and its owned operation without changing canonical state', async () => {
  const expected = await plan();
  let count = 0;
  const proxy = new Proxy(db(), {
    get(target, key) {
      if (key === 'runTransaction')
        return async (callback: any) => {
          if (++count === 3) await db().doc(sermonPath).update({ title: 'Independent concurrent change' });
          return target.runTransaction(callback);
        };
      const value = (target as any)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(applySandboxCatalogPlan(proxy, expected, owner)).rejects.toThrow('SOURCE_CHANGED');
  expect((await root().get()).get('state')).toBe('building');
  expect((await db().doc(opPath).get()).get('operationId')).toBe(owner.operationId);
  expect((await db().doc(sermonPath).get()).get('title')).toBe('Independent concurrent change');
  expect((await root().collection('catalogImports').get()).empty).toBe(true);
});
test('actual partial page acknowledgement loss resumes only exact owned plan, without duplicate or overwrite', async () => {
  const expected = await plan();
  let count = 0;
  const proxy = new Proxy(db(), {
    get(target, key) {
      if (key === 'runTransaction')
        return async (callback: any) => {
          const value = await target.runTransaction(callback);
          if (++count === 3) throw new Error('SYNTHETIC_PAGE_ACK_LOST_AFTER_COMMIT');
          return value;
        };
      const value = (target as any)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(applySandboxCatalogPlan(proxy, expected, owner)).rejects.toThrow('ACK_LOST');
  const staged = (await root().collection('resources').get()).docs.map((doc) => doc.data());
  expect(staged.length).toBeGreaterThan(0);
  await expect(applySandboxCatalogPlan(db(), { ...expected, sourceDigest: '0'.repeat(64) }, owner)).rejects.toThrow();
  await applySandboxCatalogPlan(db(), expected, owner);
  expect((await root().collection('resources').get()).size).toBe(expected.resources.length);
  expect(
    catalogDigest(
      (await root().collection('resources').get()).docs
        .map((doc) => doc.data())
        .sort((a, b) => a.id.localeCompare(b.id))
    )
  ).toBe(catalogDigest([...expected.resources].sort((a, b) => a.id.localeCompare(b.id))));
});

test('native domain change from open to paused conflicts despite effective pause remaining true', async () => {
  const expected = await plan();
  let count = 0;
  const proxy = new Proxy(db(), {
    get(target, key) {
      if (key === 'runTransaction')
        return async (callback: any) => {
          if (++count === 3) await db().doc(controlPath).update({ 'domains.publishing.admission': 'paused' });
          return target.runTransaction(callback);
        };
      const value = (target as any)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(applySandboxCatalogPlan(proxy, expected, owner)).rejects.toThrow('NATIVE_AUTHORITY_CHANGED');
  expect((await root().get()).get('state')).toBe('building');
  expect((await db().doc(opPath).get()).get('operationId')).toBe(owner.operationId);
  expect((await root().collection('catalogImports').get()).empty).toBe(true);
});
