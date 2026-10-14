import { PassThrough } from 'node:stream';

jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => {
  const actual = jest.requireActual('@upperroom/shared/firebase/firebaseAdmin').default;
  return {
    __esModule: true,
    default: {
      firestore: actual.firestore.bind(actual),
      storage: jest.fn(),
      database: jest.fn(),
    },
  };
});
jest.mock('../handleError', () => ({ __esModule: true, default: jest.fn() }));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { TOPIC_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';

const db = firebaseAdmin.firestore();
const metadataUpdate = jest.fn().mockResolvedValue(undefined);
const metadataRef = jest.fn(() => ({ update: metadataUpdate }));
const exists = jest.fn();
const save = jest.fn();
const file = {
  exists,
  save,
  getMetadata: jest.fn().mockResolvedValue([{ metadata: { timestamp: '123' } }]),
  createReadStream: jest.fn(() => {
    const stream = new PassThrough();
    stream.end('cached bundle');
    return stream;
  }),
};
(firebaseAdmin.storage as unknown as jest.Mock).mockReturnValue({ bucket: () => ({ file: () => file }) });
(firebaseAdmin.database as unknown as jest.Mock).mockReturnValue({ ref: metadataRef });
const { createBundleHandler } = require('./bundleCreationUtils') as typeof import('./bundleCreationUtils');

const control = (admission: 'open' | 'paused', owner: 'legacy' | 'temporal' = 'legacy') => ({
  schemaVersion: 1,
  revision: 1,
  releaseId: 'bundle-ingress-test',
  admission,
  domains: { bundles: { owner, admission } },
  updatedAt: Date.now(),
});
const response = () => {
  const stream = new PassThrough();
  stream.resume();
  return Object.assign(stream, {
    set: jest.fn().mockReturnThis(),
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });
};
const leases = () => db.collection('legacyAdmissionLeases').get();
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  delete process.env.TASK_ORCHESTRATOR_BUNDLES;
  jest.clearAllMocks();
  exists.mockResolvedValue([false]);
  save.mockResolvedValue(undefined);
  await db.recursiveDelete(db.collection('legacyAdmissionLeases'));
  await db.doc('_control/temporalProviderUsage').delete();
  await db.doc('_control/temporalRelease').set(control('open'));
});
afterAll(async () => {
  await db.recursiveDelete(db.collection('legacyAdmissionLeases'));
  await db.doc('_control/temporalRelease').delete();
});

describe('public bundle ingress release boundary', () => {
  it('serves a cache hit while paused without repairing or even reading metadata', async () => {
    exists.mockResolvedValue([true]);
    await db.doc('_control/temporalRelease').set(control('paused'));
    const res = response();
    await createBundleHandler(TOPIC_BUNDLE_CONFIG, {}, res);
    expect(res.set).toHaveBeenCalledWith('X-Bundle-Source', 'storage-cache');
    expect(metadataRef).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect((await leases()).size).toBe(0);
  });

  it('rejects a pause arriving after the cache lookup without any effect or lease', async () => {
    exists.mockImplementationOnce(async () => {
      await db.doc('_control/temporalRelease').set(control('paused'));
      return [false];
    });
    const res = response();
    await createBundleHandler(TOPIC_BUNDLE_CONFIG, {}, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(save).not.toHaveBeenCalled();
    expect(metadataRef).not.toHaveBeenCalled();
    expect((await leases()).size).toBe(0);
  });

  it('rejects an old environment after Temporal takes ownership', async () => {
    await db.doc('_control/temporalRelease').set(control('open', 'temporal'));
    const res = response();
    await createBundleHandler(TOPIC_BUNDLE_CONFIG, {}, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(save).not.toHaveBeenCalled();
    expect(metadataRef).not.toHaveBeenCalled();
    expect((await leases()).size).toBe(0);
  });

  it('keeps an already admitted generation visible until its final metadata effect completes', async () => {
    const entered = deferred(),
      finish = deferred();
    save.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
    });
    const res = response();
    const invocation = createBundleHandler(TOPIC_BUNDLE_CONFIG, {}, res);
    await entered.promise;
    await db.doc('_control/temporalRelease').set(control('paused'));
    const active = (await leases()).docs;
    expect(active).toHaveLength(1);
    expect(active[0].data()).toMatchObject({ state: 'active', effectsStarted: true, domain: 'bundles' });
    expect(metadataUpdate).not.toHaveBeenCalled();
    finish.resolve();
    await invocation;
    expect(metadataUpdate).toHaveBeenCalledTimes(1);
    expect((await leases()).docs[0].data()).toMatchObject({ state: 'completed', outcome: 'succeeded' });
    expect(res.send).toHaveBeenCalled();
  });
});
