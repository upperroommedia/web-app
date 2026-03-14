import type { GetListOverflowChainOutputType } from '@upperroom/contracts/getListOverflowChain';
import type { List } from '../../../types/List';
import {
  loadListDetailsPageData,
  type LoadListDetailsPageItem,
} from './[listId]';

jest.mock('../../../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({
    user: {
      isAdmin: () => true,
    },
  }),
}));

jest.mock('../../../layout/AppLayout', () => ({
  __esModule: true,
  default: ({ children }: { children?: unknown }) => children ?? null,
}));

jest.mock('../../../components/AvatarWithDefaultImage', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: jest.fn(),
  collectionGroup: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn(),
  updateDoc: jest.fn(),
  where: jest.fn(),
}));

jest.mock('../../../utils/createFunction', () => ({
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

describe('loadListDetailsPageData', () => {
  it('redirects overflow list requests to the root list before loading detail data', async () => {
    const getListDoc = jest.fn().mockResolvedValue(buildList());
    const getNodeItems = jest.fn<Promise<LoadListDetailsPageItem[]>, [string, string | undefined]>();
    const replaceRoute = jest.fn().mockResolvedValue(undefined);

    const result = await loadListDetailsPageData({
      listId: 'overflow-list',
      getListOverflowChain: async () => buildChain(),
      getListDoc,
      getNodeItems,
      replaceRoute,
    });

    expect(replaceRoute).toHaveBeenCalledWith('/admin/lists/root-list');
    expect(getListDoc).not.toHaveBeenCalled();
    expect(getNodeItems).not.toHaveBeenCalled();
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
      getNodeItems: async (firestoreListId) => {
        if (firestoreListId === 'root-list') {
          return [
            {
              id: 'sermon-a',
              title: 'A',
              position: 1,
            },
            {
              id: 'sermon-b',
              title: 'B',
              position: 2,
            },
          ];
        }

        return [
          {
            id: 'sermon-c',
            title: 'C',
            position: 1,
          },
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
});
