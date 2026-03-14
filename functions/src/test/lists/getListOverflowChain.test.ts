import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { OverflowBehavior, ListType, type List } from '@upperroom/shared/types/List';
import getlistoverflowchain from '../../getListOverflowChain';
import { getOverflowChainState } from '../../helpers/listOverflowChain';
import type { GetListOverflowChainInputType, GetListOverflowChainOutputType } from '../../../../packages/contracts/getListOverflowChain';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

type CallableAuthType = {
  uid?: string;
  token?: {
    role?: string;
  };
};

type TestRequestType<T> = {
  auth?: CallableAuthType;
  data: T;
};

type StoredListDocument = Partial<List> & {
  id: string;
  name?: string;
  title?: string;
  count?: number;
  subsplashId: string;
};

const firestore = firebaseAdmin.firestore();
const getListOverflowChainHandler = getlistoverflowchain as unknown as (
  request: TestRequestType<GetListOverflowChainInputType>
) => Promise<GetListOverflowChainOutputType>;

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const createListDocument = async (overrides: StoredListDocument): Promise<void> => {
  const now = Date.now();
  const listData: Record<string, unknown> = {
    id: overrides.id,
    name: overrides.name ?? overrides.title ?? overrides.id,
    overflowBehavior: overrides.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
    type: overrides.type ?? ListType.SERIES,
    count: overrides.count ?? 0,
    images: overrides.images ?? [],
    createdAtMillis: overrides.createdAtMillis ?? now,
    updatedAtMillis: overrides.updatedAtMillis ?? now,
    subsplashId: overrides.subsplashId,
  };

  Object.entries(overrides).forEach(([key, value]) => {
    if (typeof value !== 'undefined') {
      listData[key] = value;
    }
  });

  await firestore.collection('lists').doc(overrides.id).set(listData);
};

describe('getListOverflowChain', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearCollection('lists');
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      getListOverflowChainHandler({
        auth: undefined,
        data: { listId: 'root-list' },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('resolves an explicit-metadata overflow input back to the root chain', async () => {
    await createListDocument({
      id: 'root-list',
      name: 'Root List',
      subsplashId: 'subsplash-root',
      count: 199,
      logicalCount: 240,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-list',
      overflowDepth: 0,
      moreSermonsRef: 'subsplash-overflow',
    });
    await createListDocument({
      id: 'overflow-list',
      name: 'More Root List sermons',
      subsplashId: 'subsplash-overflow',
      count: 41,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-list',
      overflowDepth: 1,
    });

    const result = await getListOverflowChainHandler({
      auth: { uid: 'publisher-1', token: { role: 'publisher' } },
      data: { listId: 'overflow-list' },
    });

    expect(result.rootListId).toBe('root-list');
    expect(result.redirectListId).toBe('root-list');
    expect(result.logicalCount).toBe(240);
    expect(result.canMutate).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.nodes.map((node) => ({
      firestoreListId: node.firestoreListId,
      depth: node.depth,
      count: node.count,
      nextSubsplashListId: node.nextSubsplashListId,
    }))).toEqual([
      {
        firestoreListId: 'root-list',
        depth: 0,
        count: 199,
        nextSubsplashListId: 'subsplash-overflow',
      },
      {
        firestoreListId: 'overflow-list',
        depth: 1,
        count: 41,
        nextSubsplashListId: null,
      },
    ]);
  });

  it('returns the root chain directly when the request already targets the root list', async () => {
    await createListDocument({
      id: 'direct-root-list',
      name: 'Direct Root List',
      subsplashId: 'direct-root-subsplash',
      count: 50,
      logicalCount: 50,
      isRootList: true,
      rootListId: 'direct-root-list',
      overflowDepth: 0,
    });

    const result = await getListOverflowChainHandler({
      auth: { uid: 'admin-1', token: { role: 'admin' } },
      data: { listId: 'direct-root-list' },
    });

    expect(result.requestedListId).toBe('direct-root-list');
    expect(result.rootListId).toBe('direct-root-list');
    expect(result.redirectListId).toBe('direct-root-list');
    expect(result.logicalCount).toBe(50);
    expect(result.canMutate).toBe(true);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      firestoreListId: 'direct-root-list',
      depth: 0,
      count: 50,
      isRoot: true,
      parentFirestoreListId: null,
      nextSubsplashListId: null,
    });
  });

  it('falls back to legacy parent-link inference when explicit root metadata is missing', async () => {
    await createListDocument({
      id: 'legacy-root-list',
      title: 'Legacy Root List',
      subsplashId: 'legacy-root-subsplash',
      count: 199,
      moreSermonsRef: 'legacy-overflow-subsplash',
    });
    await createListDocument({
      id: 'legacy-overflow-list',
      title: 'More Legacy Root List sermons',
      subsplashId: 'legacy-overflow-subsplash',
      count: 22,
      isMoreSermonsList: true,
    });

    const result = await getOverflowChainState('legacy-overflow-list');

    expect(result.rootListId).toBe('legacy-root-list');
    expect(result.redirectListId).toBe('legacy-root-list');
    expect(result.logicalCount).toBe(221);
    expect(result.canMutate).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.nodes.map((node) => node.firestoreListId)).toEqual([
      'legacy-root-list',
      'legacy-overflow-list',
    ]);
  });

  it('marks broken chains as non-mutable when depth continuity or link targets are invalid', async () => {
    await createListDocument({
      id: 'broken-root-list',
      name: 'Broken Root List',
      subsplashId: 'broken-root-subsplash',
      count: 199,
      logicalCount: 240,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      moreSermonsRef: 'broken-overflow-subsplash',
    });
    await createListDocument({
      id: 'broken-overflow-list',
      name: 'More Broken Root List sermons',
      subsplashId: 'broken-overflow-subsplash',
      count: 41,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      moreSermonsRef: 'missing-overflow-subsplash',
    });

    const result = await getOverflowChainState('broken-root-list');

    expect(result.rootListId).toBe('broken-root-list');
    expect(result.canMutate).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'CHAIN_PARENT_CHILD_MISMATCH',
        'CHAIN_DEPTH_COLLISION',
        'CHAIN_MISSING_LINK_TARGET',
      ])
    );
    expect(result.issues.filter((issue) => issue.severity === 'blocking')).not.toHaveLength(0);
  });
});
