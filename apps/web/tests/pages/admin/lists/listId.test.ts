import type { GetListOverflowChainOutputType } from '@upperroom/contracts/getListOverflowChain';
import type { GetListPublishedDriftOutputType } from '@upperroom/contracts/getListPublishedDrift';
import type { ReorderListItemsOutputType } from '@upperroom/contracts/reorderListItems';
import type { List } from '../../../../types/List';
import { sermonStatusType, uploadStatus } from '../../../../types/SermonTypes';
import {
  applyReorderAssignmentsToItems,
  canAutoResolvePublishedDrift,
  getPhysicalListTagLabel,
  getPublishedDriftIssueMessages,
  getPublishedDriftWarningMessage,
  isStrictListActionLocked,
  loadListDetailsPageData,
  mergeRootItemsWithCanonicalMemberships,
  persistListDetailsPageOrder,
  subscribeToListDetailsLiveUpdates,
  type LoadListDetailsPageItem,
} from '../../../../pages/admin/lists/[listId]';
import { collection, doc, updateDoc, writeBatch } from '../../../../firebase/firestore';

jest.mock('../../../../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({
    user: {
      isAdmin: () => true,
    },
  }),
}));

jest.mock('../../../../layout/AppLayout', () => ({
  __esModule: true,
  default: ({ children }: { children?: unknown }) => children ?? null,
}));

jest.mock('../../../../components/AvatarWithDefaultImage', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../../../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: jest.fn(),
  collectionGroup: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn(),
  updateDoc: jest.fn(),
  writeBatch: jest.fn(),
  where: jest.fn(),
}));

jest.mock('../../../../utils/createFunction', () => ({
  createFunctionV2: jest.fn(() => jest.fn()),
}));

const buildChain = (overrides: Partial<GetListOverflowChainOutputType> = {}): GetListOverflowChainOutputType => ({
  requestedListId: 'overflow-list',
  rootListId: 'root-list',
  redirectListId: 'root-list',
  logicalCount: 4,
  canMutate: true,
  issues: [],
  nodes: [
    {
      firestoreListId: 'root-list',
      subsplashId: 'subsplash-root',
      name: 'Root List',
      depth: 0,
      count: 2,
      isRoot: true,
      parentFirestoreListId: null,
      nextSubsplashListId: 'subsplash-overflow',
    },
    {
      firestoreListId: 'overflow-list',
      subsplashId: 'subsplash-overflow',
      name: 'More Root List sermons',
      depth: 1,
      count: 2,
      isRoot: false,
      parentFirestoreListId: 'root-list',
      nextSubsplashListId: null,
    },
  ],
  ...overrides,
});

const buildList = (overrides: Partial<List> = {}): List => ({
  id: 'root-list',
  name: 'Root List',
  images: [],
  overflowBehavior: 'CREATENEWLIST' as List['overflowBehavior'],
  type: 'series' as List['type'],
  createdAtMillis: 1,
  isRootList: true,
  rootListId: 'root-list',
  overflowDepth: 0,
  ...overrides,
});

const buildPublishedDrift = (
  overrides: Partial<GetListPublishedDriftOutputType> = {}
): GetListPublishedDriftOutputType => ({
  requestedListId: 'root-list',
  rootListId: 'root-list',
  inSync: false,
  canReorder: false,
  canOverflowPublish: false,
  canDelete: true,
  canRemove: true,
  issues: [
    {
      code: 'ORDER_MISMATCH',
      severity: 'blocking',
      message: 'Published sermon order differs between Firebase and Subsplash.',
      firestoreListId: 'root-list',
    },
  ],
  localPublishedItems: [],
  remotePublishedItems: [],
  ...overrides,
});

const buildDetailItem = (overrides: Partial<LoadListDetailsPageItem> = {}): LoadListDetailsPageItem => ({
  id: 'sermon-id',
  title: 'Sermon',
  description: '',
  speakers: [],
  subtitle: '',
  dateMillis: 0,
  sourceStartTime: 0,
  durationSeconds: 0,
  topics: [],
  status: {
    subsplash: uploadStatus.NOT_UPLOADED,
    soundCloud: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PENDING,
  },
  images: [],
  createdAtMillis: 0,
  editedAtMillis: 0,
  ...overrides,
});

const mockedDoc = doc as jest.Mock;
const mockedUpdateDoc = updateDoc as jest.Mock;
const mockedWriteBatch = writeBatch as jest.Mock;

beforeEach(() => {
  mockedDoc.mockReset();
  mockedUpdateDoc.mockReset();
  mockedWriteBatch.mockReset();
  mockedDoc.mockImplementation((...segments: unknown[]) => ({ path: segments.join('/') }));
  mockedUpdateDoc.mockResolvedValue(undefined);
  mockedWriteBatch.mockReturnValue({
    set: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  });
});

describe('loadListDetailsPageData', () => {
  it('redirects overflow list requests to the root list before loading detail data', async () => {
    const getListDoc = jest.fn().mockResolvedValue(buildList());
    const getRootItems = jest.fn<Promise<LoadListDetailsPageItem[]>, [string]>();
    const replaceRoute = jest.fn().mockResolvedValue(undefined);

    const result = await loadListDetailsPageData({
      listId: 'overflow-list',
      getListOverflowChain: async () => buildChain(),
      getListDoc,
      getRootItems,
      replaceRoute,
    });

    expect(replaceRoute).toHaveBeenCalledWith('/admin/lists/root-list');
    expect(getListDoc).not.toHaveBeenCalled();
    expect(getRootItems).not.toHaveBeenCalled();
    expect(result).toEqual({
      redirected: true,
    });
  });

  it('returns a readable but read-only logical chain when mirrored coverage is incomplete', async () => {
    const result = await loadListDetailsPageData({
      listId: 'root-list',
      getListOverflowChain: async () =>
        buildChain({
          requestedListId: 'root-list',
          redirectListId: 'root-list',
        }),
      getListDoc: async () => buildList(),
      getRootItems: async () => {
        return [
          buildDetailItem({
            id: 'sermon-a',
            title: 'A',
            position: 1,
          }),
          buildDetailItem({
            id: 'sermon-b',
            title: 'B',
            position: 2,
          }),
          buildDetailItem({
            id: 'sermon-c',
            title: 'C',
            position: 3,
          }),
        ];
      },
      replaceRoute: jest.fn(),
    });

    expect(result.redirected).toBeUndefined();
    expect(result.chainView?.canSaveOrder).toBe(false);
    expect(result.chainView?.warningMessage).toContain('read-only');
    expect(result.chainView?.items.map((item) => item.id)).toEqual(['sermon-a', 'sermon-b', 'sermon-c']);
    expect(result.chainView?.boundaryMarkers).toEqual([
      expect.objectContaining({
        sourceListId: 'overflow-list',
        beforeItemId: 'sermon-c',
      }),
    ]);
  });

  it('does not load published drift diagnostics during the initial logical list load', async () => {
    const getListPublishedDrift = jest.fn().mockResolvedValue(buildPublishedDrift());

    const result = await loadListDetailsPageData({
      listId: 'root-list',
      getListOverflowChain: async () =>
        buildChain({
          requestedListId: 'root-list',
          redirectListId: 'root-list',
        }),
      getListPublishedDrift,
      getListDoc: async () => buildList({ subsplashId: 'subsplash-root' }),
      getRootItems: async () => [
        buildDetailItem({ id: 'sermon-a', title: 'A', position: 1 }),
        buildDetailItem({ id: 'sermon-b', title: 'B', position: 2 }),
        buildDetailItem({ id: 'sermon-c', title: 'C', position: 3 }),
        buildDetailItem({ id: 'sermon-d', title: 'D', position: 4 }),
      ],
      replaceRoute: jest.fn(),
    });

    expect(getListPublishedDrift).not.toHaveBeenCalled();
    expect(result.publishedDrift).toBeNull();
    expect(result.items?.map((item) => item.id)).toEqual(['sermon-a', 'sermon-b', 'sermon-c', 'sermon-d']);
  });
});

describe('getPhysicalListTagLabel', () => {
  it('labels root and overflow pages for the list item chips', () => {
    expect(getPhysicalListTagLabel({ sourceDepth: 0 })).toBe('Root page');
    expect(getPhysicalListTagLabel({ sourceDepth: 1 })).toBe('Overflow 1');
    expect(getPhysicalListTagLabel({ sourceDepth: 2 })).toBe('Overflow 2');
  });
});

describe('mergeRootItemsWithCanonicalMemberships', () => {
  it('prefers canonical membership upload status over stale root projection state', () => {
    const mergedItems = mergeRootItemsWithCanonicalMemberships({
      items: [
        {
          ...buildDetailItem({ id: 'sermon-a', title: 'A' }),
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'stale-row' },
        },
      ],
      canonicalMembershipBySermonId: new Map([
        ['sermon-a', { uploadStatus: { status: uploadStatus.NOT_UPLOADED } }],
      ]),
    });

    expect(mergedItems[0].uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
  });
});

describe('persistListDetailsPageOrder', () => {
  it('applies returned physical assignments immediately so the page tags update without reload', async () => {
    const result = applyReorderAssignmentsToItems({
      items: [
        {
          ...buildDetailItem({
            id: 'sermon-a',
            title: 'A',
            subsplashId: 'media-a',
            position: 1,
          }),
          logicalPosition: 1,
          sourceListId: 'root-list',
          sourceListName: 'Root List',
          sourceDepth: 0,
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
        },
        {
          ...buildDetailItem({
            id: 'sermon-b',
            title: 'B',
            subsplashId: 'media-b',
            position: 2,
          }),
          logicalPosition: 2,
          sourceListId: 'root-list',
          sourceListName: 'Root List',
          sourceDepth: 0,
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-b' },
        },
      ],
      assignments: [
        {
          mediaItemId: 'media-a',
          firestoreListId: 'overflow-list',
          subsplashListId: 'subsplash-overflow',
          overflowDepth: 1,
          position: 1,
        },
        {
          mediaItemId: 'media-b',
          firestoreListId: 'root-list',
          subsplashListId: 'subsplash-root',
          overflowDepth: 0,
          position: 1,
        },
      ],
      chainView: {
        rootListId: 'root-list',
        items: [],
        boundaryMarkers: [],
        nodes: [
          {
            firestoreListId: 'root-list',
            subsplashId: 'subsplash-root',
            name: 'Root List',
            depth: 0,
            isRoot: true,
            physicalCount: 1,
            localCount: 1,
            missingMirroredCount: 0,
            hasCoverageGap: false,
          },
          {
            firestoreListId: 'overflow-list',
            subsplashId: 'subsplash-overflow',
            name: 'More Root List sermons',
            depth: 1,
            isRoot: false,
            physicalCount: 1,
            localCount: 1,
            missingMirroredCount: 0,
            hasCoverageGap: false,
          },
        ],
        diagnostics: [],
        canSaveOrder: true,
        canMutate: true,
        isReadOnly: false,
        hasCoverageGap: false,
        localMirroredCount: 2,
        expectedPhysicalCount: 2,
      },
    });

    expect(result.map((item) => [item.id, item.sourceListName, item.sourceDepth])).toEqual([
      ['sermon-a', 'More Root List sermons', 1],
      ['sermon-b', 'Root List', 0],
    ]);
  });

  it('does not invoke reorder while mutation blocking is active', async () => {
    const reorderListItems = jest.fn<Promise<ReorderListItemsOutputType>, [unknown]>();

    await persistListDetailsPageOrder({
      rootListId: 'root-list',
      rootSubsplashId: 'subsplash-root',
      items: [
        {
          id: 'sermon-a',
          title: 'A',
          subsplashId: 'media-a',
          position: 1,
          logicalPosition: 1,
          sourceListId: 'root-list',
          sourceListName: 'Root List',
          sourceDepth: 0,
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
          status: {
            subsplash: uploadStatus.NOT_UPLOADED,
            soundCloud: uploadStatus.NOT_UPLOADED,
            audioStatus: sermonStatusType.PENDING,
          },
          description: '',
          speakers: [],
          subtitle: '',
          dateMillis: 0,
          sourceStartTime: 0,
          durationSeconds: 0,
          topics: [],
          images: [],
          createdAtMillis: 0,
          editedAtMillis: 0,
        },
      ],
      chainView: {
        rootListId: 'root-list',
        items: [],
        boundaryMarkers: [],
        nodes: [],
        diagnostics: [
          {
            code: 'CHAIN_PARENT_CHILD_MISMATCH',
            severity: 'blocking',
            message: 'Broken chain.',
          },
        ],
        canSaveOrder: false,
        canMutate: false,
        isReadOnly: true,
        hasCoverageGap: false,
        localMirroredCount: 1,
        expectedPhysicalCount: 1,
        warningMessage: 'This logical list is currently read-only because the overflow chain audit reported diagnostics.',
      },
      reorderListItems,
    });

    expect(reorderListItems).not.toHaveBeenCalled();
  });

  it('does not invoke reorder while published drift blocks strict actions', async () => {
    const reorderListItems = jest.fn<Promise<ReorderListItemsOutputType>, [unknown]>();

    await persistListDetailsPageOrder({
      rootListId: 'root-list',
      rootSubsplashId: 'subsplash-root',
      items: [
        {
          id: 'sermon-a',
          title: 'A',
          subsplashId: 'media-a',
          position: 1,
          logicalPosition: 1,
          sourceListId: 'root-list',
          sourceListName: 'Root List',
          sourceDepth: 0,
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
          status: {
            subsplash: uploadStatus.NOT_UPLOADED,
            soundCloud: uploadStatus.NOT_UPLOADED,
            audioStatus: sermonStatusType.PENDING,
          },
          description: '',
          speakers: [],
          subtitle: '',
          dateMillis: 0,
          sourceStartTime: 0,
          durationSeconds: 0,
          topics: [],
          images: [],
          createdAtMillis: 0,
          editedAtMillis: 0,
        },
      ],
      chainView: {
        rootListId: 'root-list',
        items: [],
        boundaryMarkers: [],
        nodes: [],
        diagnostics: [],
        canSaveOrder: true,
        canMutate: true,
        isReadOnly: false,
        hasCoverageGap: false,
        localMirroredCount: 1,
        expectedPhysicalCount: 1,
      },
      publishedDrift: buildPublishedDrift(),
      reorderListItems,
    });

    expect(reorderListItems).not.toHaveBeenCalled();
  });

  it('returns updated list item page tags after a successful reorder save', async () => {
    const reorderListItems = jest.fn<Promise<ReorderListItemsOutputType>, [unknown]>().mockResolvedValue({
      status: 'success',
      message: 'ok',
      rootListId: 'root-list',
      subsplashListId: 'subsplash-root',
      assignments: [
        {
          mediaItemId: 'media-a',
          firestoreListId: 'overflow-list',
          subsplashListId: 'subsplash-overflow',
          overflowDepth: 1,
          position: 1,
        },
      ],
    });

    const persistedItems = await persistListDetailsPageOrder({
      rootListId: 'root-list',
      rootSubsplashId: 'subsplash-root',
      items: [
        {
          ...buildDetailItem({
            id: 'sermon-a',
            title: 'A',
            subsplashId: 'media-a',
            position: 1,
          }),
          logicalPosition: 1,
          sourceListId: 'root-list',
          sourceListName: 'Root List',
          sourceDepth: 0,
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
        },
      ],
      chainView: {
        rootListId: 'root-list',
        items: [],
        boundaryMarkers: [],
        nodes: [
          {
            firestoreListId: 'root-list',
            subsplashId: 'subsplash-root',
            name: 'Root List',
            depth: 0,
            isRoot: true,
            physicalCount: 0,
            localCount: 0,
            missingMirroredCount: 0,
            hasCoverageGap: false,
          },
          {
            firestoreListId: 'overflow-list',
            subsplashId: 'subsplash-overflow',
            name: 'More Root List sermons',
            depth: 1,
            isRoot: false,
            physicalCount: 1,
            localCount: 1,
            missingMirroredCount: 0,
            hasCoverageGap: false,
          },
        ],
        diagnostics: [],
        canSaveOrder: true,
        canMutate: true,
        isReadOnly: false,
        hasCoverageGap: false,
        localMirroredCount: 1,
        expectedPhysicalCount: 1,
      },
      reorderListItems,
    });

    expect(reorderListItems).toHaveBeenCalled();
    expect(persistedItems[0]).toMatchObject({
      sourceListId: 'overflow-list',
      sourceListName: 'More Root List sermons',
      sourceDepth: 1,
      physicalPlacement: {
        firestoreListId: 'overflow-list',
        subsplashListId: 'subsplash-overflow',
        overflowDepth: 1,
        position: 1,
      },
    });
  });
});

describe('published drift helpers', () => {
  it('marks strict actions locked when published drift blocks reorder even if the chain itself is healthy', () => {
    expect(
      isStrictListActionLocked({
        chainView: {
          rootListId: 'root-list',
          items: [],
          boundaryMarkers: [],
          nodes: [],
          diagnostics: [],
          canSaveOrder: true,
          canMutate: true,
          isReadOnly: false,
          hasCoverageGap: false,
          localMirroredCount: 1,
          expectedPhysicalCount: 1,
        },
        publishedDrift: buildPublishedDrift(),
      })
    ).toBe(true);
  });

  it('returns an ignored-state warning while keeping strict actions blocked', () => {
    const publishedDrift = buildPublishedDrift();

    expect(
      getPublishedDriftWarningMessage({
        publishedDrift,
        ignored: true,
      })
    ).toContain('ignore');
    expect(getPublishedDriftIssueMessages(publishedDrift)).toEqual([
      'Published sermon order differs between Firebase and Subsplash.',
    ]);
  });

  it('disables automatic resolution for ambiguity and structural issues', () => {
    expect(
      canAutoResolvePublishedDrift(
        buildPublishedDrift({
          issues: [
            {
              code: 'REMOTE_ONLY_AMBIGUOUS_MATCH',
              severity: 'blocking',
              message: 'Duplicate local mappings exist.',
            },
          ],
        })
      )
    ).toBe(false);
  });
});

describe('subscribeToListDetailsLiveUpdates', () => {
  it('ignores the initial snapshots and reloads once when Firestore changes afterward', () => {
    jest.useFakeTimers();

    const scheduleReload = jest.fn();
    const unsubscribe = jest.fn();
    const snapshotCallbacks: Array<() => void> = [];
    const onSnapshotImpl = jest.fn((_ref, onNext: () => void) => {
      snapshotCallbacks.push(onNext);
      return unsubscribe;
    });

    const cleanup = subscribeToListDetailsLiveUpdates({
      rootListId: 'root-list',
      scheduleReload,
      onSnapshotImpl: onSnapshotImpl as unknown as typeof import('../../../../firebase/firestore').onSnapshot,
      docImpl: mockedDoc as unknown as typeof import('../../../../firebase/firestore').doc,
      collectionImpl: collection as unknown as typeof import('../../../../firebase/firestore').collection,
      collectionGroupImpl: jest.fn() as unknown as typeof import('../../../../firebase/firestore').collectionGroup,
      queryImpl: jest.fn((value) => value) as unknown as typeof import('../../../../firebase/firestore').query,
      whereImpl: jest.fn(() => ({})) as unknown as typeof import('../../../../firebase/firestore').where,
    });

    expect(snapshotCallbacks).toHaveLength(3);

    snapshotCallbacks[0]();
    snapshotCallbacks[1]();
    snapshotCallbacks[2]();
    jest.runAllTimers();
    expect(scheduleReload).not.toHaveBeenCalled();

    snapshotCallbacks[0]();
    snapshotCallbacks[1]();
    jest.runAllTimers();
    expect(scheduleReload).toHaveBeenCalledTimes(1);

    snapshotCallbacks[2]();
    jest.runAllTimers();
    expect(scheduleReload).toHaveBeenCalledTimes(2);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('does not reload if one source emits again before the other initial snapshots arrive', () => {
    jest.useFakeTimers();

    const scheduleReload = jest.fn();
    const snapshotCallbacks: Array<() => void> = [];
    const onSnapshotImpl = jest.fn((_ref, onNext: () => void) => {
      snapshotCallbacks.push(onNext);
      return jest.fn();
    });

    subscribeToListDetailsLiveUpdates({
      rootListId: 'root-list',
      scheduleReload,
      onSnapshotImpl: onSnapshotImpl as unknown as typeof import('../../../../firebase/firestore').onSnapshot,
      docImpl: mockedDoc as unknown as typeof import('../../../../firebase/firestore').doc,
      collectionImpl: collection as unknown as typeof import('../../../../firebase/firestore').collection,
      collectionGroupImpl: jest.fn() as unknown as typeof import('../../../../firebase/firestore').collectionGroup,
      queryImpl: jest.fn((value) => value) as unknown as typeof import('../../../../firebase/firestore').query,
      whereImpl: jest.fn(() => ({})) as unknown as typeof import('../../../../firebase/firestore').where,
    });

    expect(snapshotCallbacks).toHaveLength(3);

    snapshotCallbacks[0]();
    snapshotCallbacks[0]();
    jest.runAllTimers();
    expect(scheduleReload).not.toHaveBeenCalled();

    snapshotCallbacks[1]();
    snapshotCallbacks[2]();
    jest.runAllTimers();
    expect(scheduleReload).not.toHaveBeenCalled();

    snapshotCallbacks[0]();
    jest.runAllTimers();
    expect(scheduleReload).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
