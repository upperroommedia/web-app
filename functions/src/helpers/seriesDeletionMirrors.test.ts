jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => mockJobId,
  runDurableTransaction: (db: { runTransaction: (fn: unknown) => Promise<unknown> }, fn: unknown) => {
    mockFences++;
    return db.runTransaction(fn);
  },
}));
import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareSeriesDeletionMirrors,
  removeSeriesDeletionMirrors,
  projectSeriesDeletionDocument,
  SERIES_DELETION_MIRROR_PLANS,
} from './seriesDeletionMirrors';
import { desiredProviderDeletionPlanId, providerEdgeKey } from '../../../packages/orchestration/src/provider-usage';
let mockJobId: string | undefined;
let mockFences = 0;
const input = { seriesId: 'series-1', remoteSeriesId: 'remote-series' };
type Data = Record<string, any>;
function fakeFirestore() {
  const store = new Map<string, Data>();
  const deletions: string[][] = [];
  let missingIndex = false;
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path),
    collection: (name: string) => query(`${path}/${name}`, false),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: doc(path),
    exists: store.has(path),
    data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined),
    get: (key: string) => key.split('.').reduce((value, part) => value?.[part], store.get(path)),
  });
  const query = (
    path: string,
    group: boolean,
    predicates: Array<[string, unknown]> = [],
    cursor = '',
    limit = Infinity
  ): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, _operator: string, value: unknown) =>
      query(path, group, [...predicates, [field, value]], cursor, limit),
    orderBy: () => query(path, group, predicates, cursor, limit),
    limit: (value: number) => query(path, group, predicates, cursor, value),
    startAfter: (value: any) => query(path, group, predicates, value.ref.path, limit),
    get: async () => {
      if (missingIndex && group && predicates.length) throw Object.assign(new Error('missing index'), { code: 9 });
      const paths = [...store.keys()]
        .filter((key) => {
          const parts = key.split('/');
          const member = group
            ? parts[parts.length - 2] === path
            : key.startsWith(`${path}/`) && parts.length === path.split('/').length + 1;
          return member && key > cursor && predicates.every(([field, value]) => snapshot(key).get(field) === value);
        })
        .sort()
        .slice(0, limit);
      return { docs: paths.map(snapshot), size: paths.length, empty: paths.length === 0 };
    },
  });
  const db: any = {
    doc,
    collection: (name: string) => query(name, false),
    collectionGroup: (name: string) => query(name, true),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const writes: Array<() => void> = [];
      const deleted: string[] = [];
      let writing = false;
      const tx = {
        get: async (ref: any) => {
          if (writing) throw new Error('Read after write');
          return ref._query ? ref.get() : snapshot(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw new Error('Read after write');
          return refs.map((ref) => snapshot(ref.path));
        },
        create: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => {
            if (store.has(ref.path)) throw new Error('Already exists');
            store.set(ref.path, structuredClone(data));
          });
        },
        set: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => store.set(ref.path, structuredClone(data)));
        },
        update: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...structuredClone(data) }));
        },
        delete: (ref: any) => {
          writing = true;
          deleted.push(ref.path);
          writes.push(() => store.delete(ref.path));
        },
      };
      const result = await fn(tx);
      writes.forEach((write) => write());
      if (deleted.length) deletions.push(deleted);
      return result;
    },
  };
  store.set('series/series-1', { subsplashId: 'remote-series' });
  const entity = { type: 'series', id: 'series-1' };
  const intent = {
    projectId: 'urm-app',
    jobId: 'job-1',
    kind: 'series.delete',
    entity,
    generation: 1,
    payload: { kind: 'series.delete', entity, payload: { operation: 'delete', input: { firestoreId: 'series-1' } } },
  };
  store.set('durableJobIntents/job-1', intent);
  store.set('durableJobs/job-1', { ...intent, state: 'running' });
  return {
    db: db as Firestore,
    store,
    deletions,
    setMissingIndex: () => {
      missingIndex = true;
    },
  };
}

describe('series deletion frozen projections', () => {
  beforeEach(() => {
    mockJobId = 'job-1';
    mockFences = 0;
  });
  it('captures more than 501 memberships and pointers before effects, then applies paged cleanup', async () => {
    const h = fakeFirestore();
    for (let i = 0; i < 650; i++) {
      const id = i.toString().padStart(4, '0');
      h.store.set(`series/series-1/seriesItems/${id}`, { sermonId: id });
      h.store.set(`sermons/${id}`, {
        title: 'preserved',
        subsplashId: `media-${id}`,
        seriesId: 'series-1',
        seriesPublishedToSubsplash: true,
      });
    }
    const plan = await prepareSeriesDeletionMirrors(h.db, input);
    expect(h.deletions).toEqual([]);
    expect(h.store.get('sermons/0000')?.seriesId).toBe('series-1');
    expect(JSON.stringify(plan).length).toBeLessThan(1000);
    expect(
      [...h.store.keys()].filter((path) => path.startsWith(`${SERIES_DELETION_MIRROR_PLANS}/${plan.planId}/rows/`))
    ).toHaveLength(1300);
    const counts = await removeSeriesDeletionMirrors(h.db, plan);
    expect(counts).toEqual({ localSeriesItemsDeleted: 650, localSermonsUnlinked: 650, localMirrorsUpdated: 0 });
    expect(h.deletions.flat()).toHaveLength(650);
    expect(h.deletions.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(h.store.get('sermons/0000')).toEqual({
      title: 'preserved',
      subsplashId: 'media-0000',
      seriesId: null,
      seriesPublishedToSubsplash: false,
    });
    expect(h.store.has('series/series-1')).toBe(true);
    expect(await removeSeriesDeletionMirrors(h.db, plan)).toEqual(counts);
    expect(mockFences).toBeGreaterThan(30);
  });
  it('projects copied root and embedded sermon pointers and keeps unrelated content', async () => {
    const h = fakeFirestore();
    h.store.set('lists/list/listItems/sermon', {
      title: 'root',
      seriesId: 'series-1',
      seriesPublishedToSubsplash: true,
      subsplashSeriesId: 'remote-series',
      mediaItem: {
        title: 'nested',
        seriesId: 'series-1',
        seriesPublishedToSubsplash: true,
        subsplashSeriesId: 'remote-series',
        subsplashId: 'media',
      },
    });
    h.store.set('lists/list/listItems/unrelated', {
      seriesId: 'other',
      subsplashSeriesId: 'remote-series',
      title: 'blocker',
    });
    const plan = await prepareSeriesDeletionMirrors(h.db, input);
    await removeSeriesDeletionMirrors(h.db, plan);
    expect(h.store.get('lists/list/listItems/sermon')).toEqual({
      title: 'root',
      seriesId: null,
      seriesPublishedToSubsplash: false,
      mediaItem: { title: 'nested', seriesId: null, seriesPublishedToSubsplash: false, subsplashId: 'media' },
    });
    expect(h.store.get('lists/list/listItems/unrelated')).toEqual({
      seriesId: 'other',
      subsplashSeriesId: 'remote-series',
      title: 'blocker',
    });
  });
  it('writes agreed exact per-resource removal proof with full afterData', async () => {
    const h = fakeFirestore(),
      path = 'sermons/sermon';
    h.store.set(path, { seriesId: 'series-1', subsplashSeriesId: 'remote-series', title: 'same' });
    await prepareSeriesDeletionMirrors(h.db, input);
    const id = desiredProviderDeletionPlanId({
      resource: { projectId: 'urm-app', provider: 'subsplash', account: 'app:9XTSHD', remoteId: 'remote-series' },
      jobId: 'job-1',
      resourceType: 'series',
    });
    expect(h.store.get(`temporalProviderDesiredDeletionPlans/${id}`)).toMatchObject({
      entity: { type: 'series', id: 'series-1' },
      generation: 1,
      method: 'DELETE',
      state: 'prepared',
    });
    expect(h.store.get(`temporalProviderDesiredDeletionPlans/${id}/removals/${providerEdgeKey(path)}`)).toMatchObject({
      canonicalPath: path,
      after: 'resource_removed',
      afterData: { title: 'same', seriesId: null, seriesPublishedToSubsplash: false },
    });
  });
  it('rejects changed canonical data instead of overwriting it on a retry', async () => {
    const h = fakeFirestore(),
      path = 'sermons/sermon';
    h.store.set(path, { title: 'before', seriesId: 'series-1' });
    const plan = await prepareSeriesDeletionMirrors(h.db, input);
    h.store.set(path, { title: 'after', seriesId: 'series-1' });
    expect(await prepareSeriesDeletionMirrors(h.db, input)).toEqual(plan);
    await expect(removeSeriesDeletionMirrors(h.db, plan)).rejects.toThrow('PROOF_INVALID');
    expect(h.store.get(path)?.title).toBe('after');
  });
  it('never owns a membership in another series or an arbitrary document with copied IDs', () => {
    expect(
      projectSeriesDeletionDocument('series/other/seriesItems/sermon', { seriesId: 'series-1' }, input)
    ).toBeUndefined();
    expect(
      projectSeriesDeletionDocument('tenants/x/listItems/sermon', { seriesId: 'series-1' }, input)
    ).toBeUndefined();
    expect(
      projectSeriesDeletionDocument('sermons/sermon', { seriesId: 'other', subsplashSeriesId: 'remote-series' }, input)
    ).toBeUndefined();
  });
  it('validates the immutable job envelope and fresh canonical provider identity', async () => {
    const h = fakeFirestore();
    h.store.get('durableJobIntents/job-1')!.payload.kind = 'series.update';
    await expect(prepareSeriesDeletionMirrors(h.db, input)).rejects.toThrow('PROOF_INVALID');
    const fresh = fakeFirestore();
    fresh.store.set('series/series-1', { subsplashId: 'replacement' });
    await expect(prepareSeriesDeletionMirrors(fresh.db, input)).rejects.toThrow('PROOF_INVALID');
  });
  it('keeps legacy manifests paginated in private storage instead of returning a fleet array', async () => {
    mockJobId = undefined;
    const h = fakeFirestore();
    h.store.set('sermons/sermon', { seriesId: 'series-1', title: 'unchanged' });
    const plan = await prepareSeriesDeletionMirrors(h.db, input);
    expect(plan).not.toHaveProperty('legacyRows');
    expect(h.deletions).toEqual([]);
    await removeSeriesDeletionMirrors(h.db, plan);
    expect(h.store.get('sermons/sermon')?.seriesId).toBeNull();
    expect(mockFences).toBe(0);
    expect([...h.store.keys()].some((path) => path.startsWith('temporalProviderDesiredDeletionPlans'))).toBe(false);
  });
});
