import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  createYouTubeAcquisitionHostStore,
  prepareYouTubeAcquisition,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import type { MediaJobRef } from '../../../apps/process-audio/src/temporal/types';

// Actual SDK transactions in the dedicated Firebase test harness, never ADC/dev.
let app: App;
let db: Firestore;
let ref: MediaJobRef;
const buildId = 'a'.repeat(40);
const caller = {
  buildId,
  serviceAccount: `tw-m-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
  instanceId: 'native-test-instance',
};
const owner = {
  bootId: 'b'.repeat(8) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(12),
  pidNamespace: 'pid:[1234]',
  processId: 7,
  startTicks: '100',
  buildId,
};
const gatePath = () => `_testYouTubeAcquisitionAuthority/${ref.jobId}`;
const gate = async (tx: Transaction) => {
  if (!(await tx.get(db.doc(gatePath()))).get('allowed')) throw new Error('TEST_CURRENT_AUTHORITY_REVOKED');
};
const store = (change = {}) =>
  createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner: { ...owner, ...change },
    assertEligible: gate,
  });
const prepare = () => prepareYouTubeAcquisition({ firestore: db, ref, caller, assertCurrent: gate });
beforeAll(() => {
  if (
    !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ||
    process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':9')
  )
    throw new Error('Dedicated emulator harness required');
  app = initializeApp({ projectId: 'urm-app-staging' }, `acquisition-store-${randomUUID()}`);
  db = getFirestore(app);
});
beforeEach(async () => {
  ref = {
    projectId: 'urm-app-staging',
    jobId: `acq-${randomUUID()}`,
    sermonId: 'sermon-test',
    revision: 1,
    requestVersion: 'b'.repeat(16),
  };
  await db.doc(gatePath()).set({ allowed: true });
});
afterEach(async () => {
  await db.doc(gatePath()).delete();
  await db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref)).delete();
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

test('a host cannot invent a delegation from an HTTP reference', async () => {
  await expect(store().claim(ref, caller.serviceAccount)).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
  expect(await store().read(ref)).toBeUndefined();
});
test('concurrent actual transactions issue only one launch and preserve the original owner', async () => {
  await prepare();
  const results = await Promise.all(Array.from({ length: 6 }, () => store().claim(ref, caller.serviceAccount)));
  expect(results.filter((result) => result.launch)).toHaveLength(1);
  expect((await store().read(ref))?.owner).toEqual(owner);
  expect((await store().read(ref))?.status).toBe('running');
});
test('a repeated preparation/lost acknowledgement does not overwrite claimed ownership', async () => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  await prepare();
  expect(await store({ processId: 8, startTicks: '200' }).claim(ref, caller.serviceAccount)).toEqual({ launch: false });
  expect((await store().read(ref))?.owner).toEqual(owner);
});
test('elapsed time and a replacement process do not permit lease stealing or settlement', async () => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  await db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref)).update({ startedAt: 1 });
  const replacement = store({ processId: 8, startTicks: '200' });
  expect(await replacement.claim(ref, caller.serviceAccount)).toEqual({ launch: false });
  await expect(replacement.settle(ref, { kind: 'cancelled' }, async () => undefined)).rejects.toThrow(
    'YOUTUBE_ACQUISITION_OWNERSHIP'
  );
  expect((await store().read(ref))?.status).toBe('running');
});
test('revoked native preparation authority and host eligibility fail before a claim', async () => {
  await db.doc(gatePath()).update({ allowed: false });
  await expect(prepare()).rejects.toThrow('TEST_CURRENT_AUTHORITY_REVOKED');
  await db.doc(gatePath()).update({ allowed: true });
  await prepare();
  await db.doc(gatePath()).update({ allowed: false });
  await expect(store().claim(ref, caller.serviceAccount)).rejects.toThrow('TEST_CURRENT_AUTHORITY_REVOKED');
  expect((await store().read(ref))?.status).toBe('prepared');
});
test('independently verified caller identity must match the private native preparer', async () => {
  await prepare();
  await expect(store().claim(ref, 'other@urm-app-staging.iam.gserviceaccount.com')).rejects.toThrow(
    'YOUTUBE_ACQUISITION_OWNERSHIP'
  );
  expect((await store().read(ref))?.status).toBe('prepared');
});
test('a failed process drain cannot publish a terminal or ready receipt', async () => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  await expect(
    store().settle(ref, { kind: 'cancelled' }, async () => {
      throw new Error('CHILD_STILL_RUNNING');
    })
  ).rejects.toThrow('CHILD_STILL_RUNNING');
  expect((await store().read(ref))?.status).toBe('running');
});
test('source settlement requires current eligibility and records no canonical status or artifact attachment', async () => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  const artifact = {
    path: `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-test.m4a`,
    generation: '1234',
    bytes: 4000,
    crc32c: 'AAAAAA==',
  };
  await db.doc(gatePath()).update({ allowed: false });
  await expect(store().settle(ref, { kind: 'source', artifact }, async () => undefined)).rejects.toThrow(
    'TEST_CURRENT_AUTHORITY_REVOKED'
  );
  await db.doc(gatePath()).update({ allowed: true });
  await store().settle(ref, { kind: 'source', artifact }, async () => undefined);
  expect((await store().read(ref))?.result).toEqual({ kind: 'source', artifact });
  expect((await db.doc(`temporalMediaRequests/${ref.jobId}`).get()).exists).toBe(false);
  expect((await db.doc(`durableJobs/${ref.jobId}`).get()).exists).toBe(false);
});
test('a drained stop receipt can settle after canonical cancellation without reviving a task', async () => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  await db.doc(gatePath()).update({ allowed: false });
  await store().settle(ref, { kind: 'cancelled' }, async () => undefined);
  expect((await store().read(ref))?.status).toBe('cancelled');
  expect(
    await store()
      .claim(ref, caller.serviceAccount)
      .catch(() => ({ launch: false }))
  ).toEqual({ launch: false });
});

test('a mismatched native Firestore project fails before any document access', async () => {
  const foreignApp = initializeApp({ projectId: 'urm-app' }, `foreign-acquisition-${randomUUID()}`);
  const foreign = getFirestore(foreignApp);
  const access = jest.spyOn(foreign, 'collection');
  try {
    expect(() =>
      createYouTubeAcquisitionHostStore({ firestore: foreign, projectId: ref.projectId, owner, assertEligible: gate })
    ).toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
    await expect(prepareYouTubeAcquisition({ firestore: foreign, ref, caller, assertCurrent: gate })).rejects.toThrow(
      'YOUTUBE_ACQUISITION_OWNERSHIP'
    );
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
    await foreign.terminate();
    await deleteApp(foreignApp);
  }
});
test.each([
  {
    status: 'source',
    result: { kind: 'source', artifact: { path: 'foreign', generation: '1', duration: 1 } },
    drainedAt: 1,
  },
  { status: 'cancelled', result: { kind: 'deleted' }, drainedAt: 1 },
  { status: 'running', result: { kind: 'cancelled' } },
  { status: 'source', drainedAt: 1 },
])('corrupt or conflicting stored state is not accepted: %j', async (patch) => {
  await prepare();
  await store().claim(ref, caller.serviceAccount);
  await db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref)).update(patch);
  await expect(store().read(ref)).rejects.toThrow();
});

test('a named database cannot receive the default-database delegation', async () => {
  const namedApp = initializeApp({ projectId: 'urm-app-staging' }, `named-acquisition-${randomUUID()}`);
  const named = getFirestore(namedApp, 'unexpected');
  const access = jest.spyOn(named, 'collection');
  try {
    expect(() =>
      createYouTubeAcquisitionHostStore({ firestore: named, projectId: ref.projectId, owner, assertEligible: gate })
    ).toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
    await expect(prepareYouTubeAcquisition({ firestore: named, ref, caller, assertCurrent: gate })).rejects.toThrow(
      'YOUTUBE_ACQUISITION_OWNERSHIP'
    );
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
    await named.terminate();
    await deleteApp(namedApp);
  }
});

test('source-available settlement cannot grant another acquisition after a canonical source appears', async () => {
  const guarded = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    assertEligible: async (tx, _ref, purpose) => {
      const gate = await tx.get(db.doc(gatePath()));
      if (!gate.get('allowed') || Boolean(gate.get('sourceAvailable')) !== (purpose === 'source_available'))
        throw new Error('PURPOSE_INELIGIBLE');
    },
  });
  await prepare();
  await guarded.claim(ref, caller.serviceAccount);
  await db.doc(gatePath()).update({ sourceAvailable: true });
  await expect(guarded.assertCurrent(ref)).rejects.toThrow('PURPOSE_INELIGIBLE');
  await guarded.settle(ref, { kind: 'source_available' }, async () => undefined);
  expect((await guarded.read(ref))?.result).toEqual({ kind: 'source_available' });
  expect((await db.doc(`temporalMediaRequests/${ref.jobId}`).get()).exists).toBe(false);
});
