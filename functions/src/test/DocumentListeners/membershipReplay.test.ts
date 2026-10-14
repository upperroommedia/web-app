import type { Firestore } from 'firebase-admin/firestore';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import {
  deriveMembershipCounts,
  syncMembershipInvariants,
} from '../../DocumentListeners/SermonLists/syncMembershipInvariants';

const mockDb = { doc: jest.fn(), collection: jest.fn(), runTransaction: jest.fn() };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: (_path: string, handler: unknown) => handler,
  onDocumentDeleted: (_path: string, handler: unknown) => handler,
}));
jest.mock('../../firestoreDataConverter', () => ({ firestoreAdminListConverter: {} }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('../../helpers/listOverflowChain', () => ({
  shouldMirrorPhysicalListItemToRootMembership: (list: { isRootList?: boolean; isMoreSermonsList?: boolean }) =>
    list.isRootList !== false && list.isMoreSermonsList !== true,
}));
jest.mock('../../removeFromList', () => ({ removeFromList: jest.fn() }));
jest.mock('../../DocumentListeners/providerListenerContinuation', () => ({
  ...jest.requireActual('../../DocumentListeners/providerListenerContinuation'),
  runLegacyProviderListener: async (input: {
    firestore: Firestore;
    validateCurrent(tx: unknown): Promise<boolean>;
    effect(key: string, verify: () => Promise<boolean>): Promise<unknown>;
  }) =>
    input.firestore.runTransaction(async (tx) => {
      if (await input.validateCurrent(tx)) await input.effect('test', async () => true);
    }),
}));
import { removeFromList } from '../../removeFromList';
import sermonListOnDelete from '../../DocumentListeners/SermonLists/sermonListOnDelete';
import listItemOnCreate from '../../DocumentListeners/Lists/listItemOnCreate';

function mockFirestore(initial: Record<string, Record<string, unknown>>) {
  const state = new Map(Object.entries(initial));
  const reference = (path: string, filters: Array<[string, unknown]> = []): any => ({
    path,
    filters,
    where: (field: string, _op: string, value: unknown) => reference(path, [...filters, [field, value]]),
    count: () => ({ path, filters, aggregate: true }),
    collection: (id: string) => reference(`${path}/${id}`),
    doc: (id: string) => reference(`${path}/${id}`),
    withConverter() {
      return this;
    },
    get() {
      return transaction.get(this);
    },
  });
  const transaction = {
    get: jest.fn(async (ref: { path: string; aggregate?: boolean; filters?: Array<[string, unknown]> }) => {
      if (ref.aggregate) {
        const docs = [...state].filter(
          ([key]) => key.startsWith(`${ref.path}/`) && key.split('/').length === ref.path.split('/').length + 1
        );
        const count = docs.filter(([, data]) =>
          (ref.filters ?? []).every(
            ([field, value]) => field.split('.').reduce((result: any, key) => result?.[key], data) === value
          )
        ).length;
        return { data: () => ({ count }) };
      }
      if (ref.path.split('/').length % 2) {
        const docs = [...state]
          .filter(([key]) => key.startsWith(`${ref.path}/`) && key.split('/').length === ref.path.split('/').length + 1)
          .map(([key, value]) => ({ id: key.split('/').at(-1), exists: true, data: () => value }));
        return { docs, size: docs.length };
      }
      return {
        exists: state.has(ref.path),
        data: () => state.get(ref.path),
        createTime: { seconds: 0, nanoseconds: 0 },
        get: (key: string) => state.get(ref.path)?.[key],
      };
    }),
    update: jest.fn((ref: { path: string }, data: Record<string, unknown>) =>
      state.set(ref.path, { ...state.get(ref.path), ...data })
    ),
    set: jest.fn((ref: { path: string }, data: Record<string, unknown>) => state.set(ref.path, data)),
    create: jest.fn((ref: { path: string }, data: Record<string, unknown>) => state.set(ref.path, data)),
  };
  const db = {
    doc: reference,
    collection: reference,
    runTransaction: async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction),
  };
  return { db: db as unknown as Firestore, state, transaction };
}

const uploaded = { uploadStatus: { status: uploadStatus.UPLOADED as const, listItemId: 'remote-row' } };

describe('membership listener current-state invariants', () => {
  it('derives zero, partial, and fully uploaded counters', () => {
    expect(deriveMembershipCounts([])).toEqual({
      numberOfLists: 0,
      numberOfListsUploadedTo: 0,
      'status.subsplash': uploadStatus.NOT_UPLOADED,
    });
    expect(deriveMembershipCounts([uploaded, {}])).toEqual({
      numberOfLists: 2,
      numberOfListsUploadedTo: 1,
      'status.subsplash': uploadStatus.NOT_UPLOADED,
    });
    expect(deriveMembershipCounts([uploaded])).toEqual({
      numberOfLists: 1,
      numberOfListsUploadedTo: 1,
      'status.subsplash': uploadStatus.UPLOADED,
    });
  });

  it('replaying create/update/delete derives identical counters and preserves current uploaded placement', async () => {
    const { db, state } = mockFirestore({
      'sermons/s': { numberOfLists: 99, numberOfListsUploadedTo: -4 },
      'sermons/s/sermonLists/l': uploaded,
      'lists/l/listItems/s': { physicalPlacement: { listId: 'physical' } },
    });
    for (let i = 0; i < 3; i++) await syncMembershipInvariants(db, 's', 'l');
    expect(state.get('sermons/s')).toMatchObject({ numberOfLists: 1, numberOfListsUploadedTo: 1 });
    expect(state.get('lists/l/listItems/s')).toEqual({ ...uploaded, physicalPlacement: { listId: 'physical' } });
  });

  it('delayed events for deleted canonical memberships clear placement and never recreate membership', async () => {
    const { db, state } = mockFirestore({
      'sermons/s': {},
      'lists/l/listItems/s': { ...uploaded, physicalPlacement: {} },
    });
    await syncMembershipInvariants(db, 's', 'l');
    expect(state.get('sermons/s')).toMatchObject({ numberOfLists: 0, numberOfListsUploadedTo: 0 });
    expect(state.get('lists/l/listItems/s')).toEqual({ uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
    expect(state.has('sermons/s/sermonLists/l')).toBe(false);
  });

  it('never recreates deleted sermons or deleted projections', async () => {
    const deleted = mockFirestore({ 'sermons/s/sermonLists/l': uploaded });
    await syncMembershipInvariants(deleted.db, 's', 'l');
    expect(deleted.transaction.update).not.toHaveBeenCalled();
    const noProjection = mockFirestore({ 'sermons/s': {}, 'sermons/s/sermonLists/l': uploaded });
    await syncMembershipInvariants(noProjection.db, 's', 'l');
    expect(noProjection.transaction.set).not.toHaveBeenCalled();
  });
});

describe('physical list create replay', () => {
  async function run(initial: Record<string, Record<string, unknown>>) {
    const fixture = mockFirestore(initial);
    Object.assign(mockDb, fixture.db);
    await (listItemOnCreate as unknown as (event: unknown) => Promise<void>)({
      params: { listId: 'l', sermonId: 's' },
    });
    return fixture;
  }

  it('replayed create derives count rather than incrementing and preserves canonical status', async () => {
    const initial = {
      'lists/l': { id: 'l', count: 99 },
      'lists/l/listItems/s': {},
      'sermons/s': {},
      'sermons/s/sermonLists/l': uploaded,
    };
    const { state } = await run(initial);
    expect(state.get('lists/l')?.count).toBe(1);
    expect(state.get('sermons/s/sermonLists/l')).toEqual(uploaded);
  });

  it.each(['row', 'sermon'])('delayed create cannot mirror after %s deletion', async (deleted) => {
    const initial: Record<string, Record<string, unknown>> = { 'lists/l': { id: 'l' } };
    if (deleted !== 'row') initial['lists/l/listItems/s'] = {};
    if (deleted !== 'sermon') initial['sermons/s'] = {};
    const { state } = await run(initial);
    expect(state.has('sermons/s/sermonLists/l')).toBe(false);
  });

  it('does not recreate canonical membership from a durable projection', async () => {
    const { state } = await run({
      'lists/l': { id: 'l' },
      'lists/l/listItems/s': { _durableMembershipJobId: 'job' },
      'sermons/s': {},
    });
    expect(state.has('sermons/s/sermonLists/l')).toBe(false);
  });

  it('does not mirror overflow pages, but derives physical count', async () => {
    const { state } = await run({
      'lists/l': { id: 'l', isMoreSermonsList: true },
      'lists/l/listItems/s': {},
      'sermons/s': {},
    });
    expect(state.get('lists/l')?.count).toBe(1);
    expect(state.has('sermons/s/sermonLists/l')).toBe(false);
  });
});

describe('canonical delete provider ownership', () => {
  it.each(['durable', 'recreated', 'deleted-sermon'])('skips destructive provider cleanup for %s', async (kind) => {
    jest.mocked(removeFromList).mockClear();
    const state: Record<string, Record<string, unknown>> = { 'sermons/s': { subsplashId: 'remote-media' } };
    if (kind === 'deleted-sermon') delete state['sermons/s'];
    if (kind === 'recreated') state['sermons/s/sermonLists/l'] = uploaded;
    const fixture = mockFirestore(state);
    Object.assign(mockDb, fixture.db);
    await (sermonListOnDelete as unknown as (event: unknown) => Promise<void>)({
      id: 'membership-event',
      time: '2026-01-01T00:00:00Z',
      params: { sermonId: 's', sermonListId: 'l' },
      data: {
        createTime: { seconds: 1, nanoseconds: 0 },
        data: () => ({
          id: 'l',
          subsplashId: 'remote-list',
          ...uploaded,
          ...(kind === 'durable' ? { _durableMembershipJobId: 'job' } : {}),
        }),
      },
    });
    expect(removeFromList).not.toHaveBeenCalled();
  });
});
