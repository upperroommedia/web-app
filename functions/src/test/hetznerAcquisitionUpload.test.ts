import { randomUUID } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { Storage, CRC32C } from '@google-cloud/storage';
import {
  createYouTubeAcquisitionHostStore,
  prepareYouTubeAcquisition,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import {
  uploadYouTubeObject,
  YouTubeUploadProducerFailed,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-upload';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import type { MediaJobRef } from '../../../apps/process-audio/src/temporal/types';
let app: App, db: Firestore, ref: MediaJobRef;
const buildId = 'a'.repeat(40);
const caller = {
  buildId,
  serviceAccount: `tw-m-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
  instanceId: 'upload-test',
};
const owner = {
  bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  pidNamespace: 'pid:[1234]',
  processId: 7,
  startTicks: '100',
  buildId,
};
const bucket = new Storage({ projectId: 'urm-app-staging' }).bucket('urm-app-staging.firebasestorage.app');
const gate = async (tx: Transaction) => {
  if (!(await tx.get(db.doc(`_testYouTubeUpload/${ref.jobId}`))).get('allowed')) throw new Error('REVOKED');
};
const store = (processId = 7) =>
  createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner: { ...owner, processId },
    assertEligible: gate,
  });
const paths: string[] = [];
const journal = () => {
  const j = store().upload(ref, randomUUID());
  paths.push(j.path);
  return j;
};
beforeAll(() => {
  for (const host of [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_STORAGE_EMULATOR_HOST])
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '') || host?.endsWith(':9'))
      throw new Error('Dedicated emulator harness required');
  app = initializeApp({ projectId: 'urm-app-staging' }, `upload-${randomUUID()}`);
  db = getFirestore(app);
});
beforeEach(async () => {
  ref = {
    projectId: 'urm-app-staging',
    sermonId: `upload-${randomUUID()}`,
    jobId: `upload-${randomUUID()}`,
    requestVersion: 'b'.repeat(16),
    revision: 1,
  };
  await db.doc(`_testYouTubeUpload/${ref.jobId}`).set({ allowed: true });
  await prepareYouTubeAcquisition({ firestore: db, ref, caller, assertCurrent: gate });
  await store().claim(ref, caller.serviceAccount);
});
afterEach(async () => {
  for (const path of paths.splice(0)) await bucket.file(path).delete({ ignoreNotFound: true });
  await db.recursiveDelete(db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref)));
  await db.doc(`_testYouTubeUpload/${ref.jobId}`).delete();
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

test('native Storage streaming returns exact bytes/checksum and repeats by GET without another producer', async () => {
  const j = journal();
  const data = Buffer.alloc(128 * 1024, 42);
  const drain = jest.fn(async () => undefined);
  const start = jest.fn(async () => ({
    output: Readable.from([data]),
    completion: Promise.resolve('succeeded' as const),
    drain,
  }));
  const receipt = await uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start });
  const checksum = new CRC32C();
  checksum.update(data);
  expect(receipt).toEqual({
    path: j.path,
    generation: expect.stringMatching(/^[1-9][0-9]*$/),
    bytes: data.length,
    crc32c: checksum.toString(),
  });
  expect(drain).toHaveBeenCalledTimes(1);
  expect(await uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start })).toEqual(receipt);
  expect(start).toHaveBeenCalledTimes(1);
  expect((await bucket.file(receipt.path, { generation: receipt.generation }).download())[0]).toEqual(data);
});
test('an unresolved previous attempt fences both same-ID relaunch and a different upload', async () => {
  const j = journal();
  expect(await j.begin()).toEqual({ launch: true });
  const start = jest.fn();
  await expect(uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start })).rejects.toThrow(
    'YOUTUBE_UPLOAD_UNCERTAIN'
  );
  expect(start).not.toHaveBeenCalled();
  await expect(journal().begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});
test('failed native producer cannot create a successful source receipt and must drain', async () => {
  const j = journal();
  const drain = jest.fn(async () => undefined);
  await expect(
    uploadYouTubeObject({
      journal: j,
      signal: new AbortController().signal,
      start: async () => ({
        output: Readable.from([Buffer.from('partial')]),
        completion: Promise.resolve('failed'),
        drain,
      }),
    })
  ).rejects.toThrow();
  expect(drain).toHaveBeenCalledTimes(1);
  const start = jest.fn();
  await expect(uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start })).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});
test('lost complete-byte receipt reconciles the same object by native GET without replaying bytes', async () => {
  const j = journal();
  await j.begin();
  const data = Buffer.from('known-complete-native-producer');
  const crc = new CRC32C();
  crc.update(data);
  await bucket
    .file(j.path)
    .save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { metadata: j.binding } });
  await j.recordBytes({ bytes: data.length, crc32c: crc.toString() });
  const start = jest.fn();
  const result = await uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start });
  expect(result.bytes).toBe(data.length);
  expect(start).not.toHaveBeenCalled();
});
test('wrong checksum and native owner replacement cannot retain an object', async () => {
  const j = journal();
  await j.begin();
  await bucket.file(j.path).save('different');
  await j.recordBytes({ bytes: 9, crc32c: 'AAAAAA==' });
  await expect(
    uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start: jest.fn() })
  ).rejects.toThrow('YOUTUBE_UPLOAD_UNCERTAIN');
  await expect(store(8).upload(ref, randomUUID()).begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});

test('corrupt streaming journals cannot claim completed bytes or authorize retention', async () => {
  const j = journal();
  await j.begin();
  const data = Buffer.from('not-native-completion');
  const crc = new CRC32C();
  crc.update(data);
  await bucket.file(j.path).save(data);
  const attemptId = j.path.split('source-')[1].replace('.bin', '');
  await db
    .collection(YOUTUBE_ACQUISITIONS)
    .doc(youtubeAcquisitionId(ref))
    .collection('uploads')
    .doc(attemptId)
    .update({ expected: { bytes: data.length, crc32c: crc.toString() } });
  await expect(
    uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start: jest.fn() })
  ).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});

test('unknown native drain cannot record completed bytes or permit replacement upload', async () => {
  const j = journal();
  const drain = jest.fn(async () => {
    throw new Error('native descendant unconfirmed');
  });
  await expect(
    uploadYouTubeObject({
      journal: j,
      signal: new AbortController().signal,
      start: async () => ({
        output: Readable.from([Buffer.from('full')]),
        completion: Promise.resolve('succeeded'),
        drain,
      }),
    })
  ).rejects.toThrow('native descendant unconfirmed');
  expect(drain).toHaveBeenCalledTimes(1);
  await expect(journal().begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});
test('permission revocation after native producer drain prevents artifact retention', async () => {
  const j = journal();
  await expect(
    uploadYouTubeObject({
      journal: j,
      signal: new AbortController().signal,
      start: async () => ({
        output: Readable.from([Buffer.from('full')]),
        completion: Promise.resolve('succeeded'),
        drain: async () => {
          await db.doc(`_testYouTubeUpload/${ref.jobId}`).set({ allowed: false });
        },
      }),
    })
  ).rejects.toThrow('REVOKED');
});
test('concurrent distinct attempt admissions authorize exactly one producer', async () => {
  const all = Array.from({ length: 5 }, () => journal());
  const results = await Promise.allSettled(all.map((j) => j.begin()));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
});

test('cancellation while a producer is silent drains before returning and fences replay', async () => {
  const j = journal();
  const controller = new AbortController();
  const output = new PassThrough();
  let finish: (value: 'succeeded' | 'failed') => void = () => undefined;
  const completion = new Promise<'succeeded' | 'failed'>((resolve) => {
    finish = resolve;
  });
  const drain = jest.fn(async () => {
    output.destroy();
    finish('failed');
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await expect(
      uploadYouTubeObject({
        journal: j,
        signal: controller.signal,
        start: async () => {
          timer = setTimeout(() => controller.abort(), 20);
          return { output, completion, drain };
        },
      })
    ).rejects.toThrow();
    expect(drain).toHaveBeenCalledTimes(1);
    const start = jest.fn();
    await expect(uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start })).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  } finally {
    if (timer) clearTimeout(timer);
    output.destroy();
  }
});

test('matching bytes without immutable operation metadata cannot be adopted', async () => {
  const j = journal();
  await j.begin();
  const data = Buffer.from('complete-but-unbound');
  const crc = new CRC32C();
  crc.update(data);
  await bucket.file(j.path).save(data);
  await j.recordBytes({ bytes: data.length, crc32c: crc.toString() });
  await expect(
    uploadYouTubeObject({ journal: j, signal: new AbortController().signal, start: jest.fn() })
  ).rejects.toThrow('YOUTUBE_UPLOAD_UNCERTAIN');
});

test('cancellation after completed upload still drains a producer that has not exited', async () => {
  const j = journal();
  const controller = new AbortController();
  let finish: (value: 'succeeded' | 'failed') => void = () => undefined;
  const completion = new Promise<'succeeded' | 'failed'>((resolve) => {
    finish = resolve;
  });
  const drain = jest.fn(async () => {
    finish('failed');
  });
  const output = Readable.from([Buffer.from('already-ended-output')]);
  let cancelTimer: NodeJS.Timeout | undefined;
  let safetyTimer: NodeJS.Timeout | undefined;
  try {
    const result = uploadYouTubeObject({
      journal: j,
      signal: controller.signal,
      start: async () => {
        output.once('end', () => {
          cancelTimer = setTimeout(() => controller.abort(), 1000);
        });
        return { output, completion, drain };
      },
    });
    await expect(
      Promise.race([
        result,
        new Promise((_, reject) => {
          safetyTimer = setTimeout(() => {
            controller.abort();
            reject(new Error('TEST_DRAIN_TIMEOUT'));
          }, 4000);
        }),
      ])
    ).rejects.not.toThrow('TEST_DRAIN_TIMEOUT');
    expect(drain).toHaveBeenCalledTimes(1);
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (safetyTimer) clearTimeout(safetyTimer);
    controller.abort();
    finish('failed');
    output.destroy();
  }
});

test('a confirmed failed native attempt can yield a fresh isolated upload without reusing its bytes', async () => {
  const old = journal();
  await expect(
    uploadYouTubeObject({
      journal: old,
      signal: new AbortController().signal,
      start: async () => ({
        output: Readable.from([Buffer.from('partial-old')]),
        completion: Promise.resolve('failed'),
        drain: async () => undefined,
      }),
    })
  ).rejects.toBeInstanceOf(YouTubeUploadProducerFailed);
  const next = journal();
  const receipt = await uploadYouTubeObject({
    journal: next,
    signal: new AbortController().signal,
    start: async () => ({
      output: Readable.from([Buffer.from('complete-new')]),
      completion: Promise.resolve('succeeded'),
      drain: async () => undefined,
    }),
  });
  expect(receipt.path).not.toBe(old.path);
  expect((await bucket.file(receipt.path, { generation: receipt.generation }).download())[0].toString()).toBe(
    'complete-new'
  );
  await expect(old.begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});
test('transfer failure which stops the native producer cannot be relabelled as an authentication retry', async () => {
  const j = journal();
  let finish: (value: 'succeeded' | 'failed') => void = () => undefined;
  const completion = new Promise<'succeeded' | 'failed'>((resolve) => {
    finish = resolve;
  });
  const output = Readable.from(
    (async function* () {
      yield Buffer.from('partial');
      throw new Error('source pipeline interrupted');
    })()
  );
  const result = uploadYouTubeObject({
    journal: j,
    signal: new AbortController().signal,
    start: async () => ({
      output,
      completion,
      drain: async () => {
        finish('failed');
      },
    }),
  });
  await expect(result).rejects.not.toBeInstanceOf(YouTubeUploadProducerFailed);
  await expect(journal().begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});
test('fresh attempt permission checks reject a revoked actor and replacement native owner', async () => {
  await expect(store().assertCurrent(ref)).resolves.toBeUndefined();
  await expect(store(8).assertCurrent(ref)).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
  await db.doc(`_testYouTubeUpload/${ref.jobId}`).set({ allowed: false });
  await expect(store().assertCurrent(ref)).rejects.toThrow('REVOKED');
});

test('independent source failure during delayed teardown cannot be mistaken for native-provider failure', async () => {
  const j = journal();
  let finishNative: (value: 'succeeded' | 'failed') => void = () => undefined;
  const completion = new Promise<'succeeded' | 'failed'>((resolve) => {
    finishNative = resolve;
  });
  const output = new Readable({
    read() {
      this.destroy(new Error('independent source failure'));
    },
    destroy(error, done) {
      finishNative('failed');
      setTimeout(() => done(error), 50);
    },
  });
  await expect(
    uploadYouTubeObject({
      journal: j,
      signal: new AbortController().signal,
      start: async () => ({ output, completion, drain: async () => undefined }),
    })
  ).rejects.not.toBeInstanceOf(YouTubeUploadProducerFailed);
  await expect(journal().begin()).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
});
