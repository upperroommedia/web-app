const refFor = (path: string): any => ({
  path,
  id: path.split('/').pop(),
  collection: (name: string) => refFor(`${path}/${name}`),
  doc: (id: string) => refFor(`${path}/${id}`),
  orderBy: () => refFor(path),
  limit: () => refFor(path),
});
const mockDb = { doc: refFor };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
import { commitPublishingUpdateMemberships, reconcilePublishingUpdateMemberships } from './updateMembership';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { PrivatePublishingIntent } from './types';
import type { Transaction } from 'firebase-admin/firestore';
const ref = { jobId: 'job', projectId: 'test' } as DurableJobRef;
const intent = (payload: Record<string, unknown> = {}): PrivatePublishingIntent => ({
  sermonId: 'sermon',
  action: 'update',
  actorUid: 'actor',
  generation: 1,
  destinations: { listIds: ['new'], soundcloud: false },
  payload: {
    hasMembershipSelection: true,
    previousListIds: ['old'],
    publishedListIds: [],
    previousSeriesId: null,
    desiredSeriesId: null,
    previousSeriesPublished: false,
    ...payload,
  },
});
function store() {
  return {
    assertCurrent: jest.fn(),
    commitCurrent: jest.fn(),
    mutateLists: jest.fn(),
    mutateSeries: jest.fn(),
    ensureSubsplashMedia: jest.fn(),
    awaitSubsplashReady: jest.fn(),
  };
}
it('never creates or publishes providers for an edit of draft memberships', async () => {
  const deps = store();
  await reconcilePublishingUpdateMemberships(ref, intent(), deps);
  expect(deps.ensureSubsplashMedia).not.toHaveBeenCalled();
  expect(deps.mutateLists).not.toHaveBeenCalled();
  expect(deps.mutateSeries).not.toHaveBeenCalled();
});
it('removes a previously published list without publishing newly selected draft lists', async () => {
  const deps = store();
  await reconcilePublishingUpdateMemberships(ref, intent({ publishedListIds: ['old'] }), deps);
  expect(deps.mutateLists).toHaveBeenCalledTimes(1);
  expect(deps.mutateLists).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({ action: 'unpublish', destinations: { listIds: ['old'], soundcloud: false } })
  );
  expect(deps.ensureSubsplashMedia).not.toHaveBeenCalled();
});
it('moves an existing series publication only after removal and playable-media confirmation', async () => {
  const deps = store(),
    order: string[] = [];
  deps.mutateSeries.mockImplementation(async (_ref, moved) => {
    order.push(moved.action);
  });
  deps.ensureSubsplashMedia.mockImplementation(async () => {
    order.push('media');
  });
  deps.awaitSubsplashReady.mockImplementation(async () => {
    order.push('ready');
  });
  await reconcilePublishingUpdateMemberships(
    ref,
    intent({ previousSeriesId: 'old-series', desiredSeriesId: 'new-series', previousSeriesPublished: true }),
    deps
  );
  expect(order).toEqual(['unpublish', 'media', 'ready', 'publish']);
});
it('performs every final projection read before writes and preserves draft upload state', async () => {
  let wrote = false;
  const set = jest.fn(() => {
      wrote = true;
    }),
    del = jest.fn(() => {
      wrote = true;
    });
  const snap = (path: string, data: Record<string, unknown> | undefined) => ({
    ref: refFor(path),
    id: path.split('/').pop(),
    exists: !!data,
    data: () => data,
    get: (field: string) => data?.[field],
  });
  const get = jest.fn(async (query) => {
    expect(wrote).toBe(false);
    if (query.path === 'sermons/sermon') return snap(query.path, { id: 'sermon', title: 'Before' });
    if (query.path === 'sermons/sermon/sermonLists')
      return {
        docs: [snap('sermons/sermon/sermonLists/old', { uploadStatus: { status: uploadStatus.NOT_UPLOADED } })],
      };
    if (query.path === 'lists/new') return snap(query.path, { name: 'New list', subsplashId: 'remote' });
    return snap(query.path, undefined);
  });
  await commitPublishingUpdateMemberships(ref, intent({ patch: { title: 'After' } }), {
    get,
    set,
    delete: del,
    update: jest.fn(),
  } as unknown as Transaction);
  expect(del).toHaveBeenCalledWith(expect.objectContaining({ path: 'sermons/sermon/sermonLists/old' }));
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'sermons/sermon/sermonLists/new' }),
    expect.objectContaining({ uploadStatus: { status: uploadStatus.NOT_UPLOADED }, _durableMembershipJobId: 'job' }),
    { merge: true }
  );
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'lists/new/listItems/sermon' }),
    expect.objectContaining({ title: 'After' }),
    { merge: true }
  );
});

it('rejects an oversized immutable edit before any provider effects', async () => {
  const deps = store();
  const large = intent({
    previousListIds: Array.from({ length: 151 }, (_, i) => String(i)),
    publishedListIds: ['old'],
  });
  await expect(reconcilePublishingUpdateMemberships(ref, large, deps)).rejects.toMatchObject({
    code: 'failed-precondition',
  });
  expect(deps.mutateLists).not.toHaveBeenCalled();
  expect(deps.mutateSeries).not.toHaveBeenCalled();
});
it('rejects concurrent membership additions before final projection can erase them', async () => {
  const set = jest.fn(),
    del = jest.fn();
  const snapshot = (path: string, data: Record<string, unknown>) => ({
    ref: refFor(path),
    id: path.split('/').pop(),
    exists: true,
    data: () => data,
    get: (key: string) => data[key],
  });
  const get = jest.fn(async (query) =>
    query.path.startsWith('temporalPublishingUpdateCheckpoints/')
      ? snapshot(query.path, {})
      : query.path === 'sermons/sermon'
      ? snapshot(query.path, { id: 'sermon' })
      : {
          docs: [snapshot('sermons/sermon/sermonLists/old', {}), snapshot('sermons/sermon/sermonLists/concurrent', {})],
          size: 2,
        }
  );
  await expect(
    commitPublishingUpdateMemberships(ref, intent({ previousMembershipHash: 'trusted' }), {
      get,
      set,
      delete: del,
      update: jest.fn(),
    } as unknown as Transaction)
  ).rejects.toMatchObject({ code: 'PUBLISHING_DRIFT' });
  expect(set).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});

it('reuses the exact private completed selection checkpoint without rewriting newer membership state', async () => {
  const get = jest.fn(async () => ({
    get: (key: string) =>
      ((
        { projectId: 'test', jobId: 'job', sermonId: 'sermon', finalMembershipsCommitted: true } as Record<
          string,
          unknown
        >
      )[key]),
  }));
  const set = jest.fn(),
    update = jest.fn(),
    remove = jest.fn();
  await commitPublishingUpdateMemberships(ref, intent(), {
    get,
    set,
    update,
    delete: remove,
  } as unknown as Transaction);
  expect(get).toHaveBeenCalledTimes(1);
  expect(set).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
it('rejects a completed selection checkpoint from another job or project', async () => {
  const get = jest.fn(async () => ({
    get: (key: string) =>
      ((
        { projectId: 'other', jobId: 'job', sermonId: 'sermon', finalMembershipsCommitted: true } as Record<
          string,
          unknown
        >
      )[key]),
  }));
  const set = jest.fn();
  await expect(
    commitPublishingUpdateMemberships(ref, intent(), { get, set } as unknown as Transaction)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(set).not.toHaveBeenCalled();
});
