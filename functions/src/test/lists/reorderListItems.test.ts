import { OverflowBehavior } from '@upperroom/shared/types/List';
import { networkFailureInjector, subsplashMock } from '../addToList/mocks';
import reorderListItems from '../../reorderListItems';
import type {
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../../../packages/contracts/reorderListItems';
import { createListDocument, clearFirestore } from '../addToList/firestoreHelpers';
import { SubsplashListRow } from '../../types/Subsplash';

type TestRequest = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: ReorderListItemsInputType;
};

type ReorderListItemsHandler = (
  request: TestRequest
) => Promise<ReorderListItemsOutputType>;

const reorderListItemsHandler = reorderListItems as unknown as ReorderListItemsHandler;

const createMediaRow = (
  listId: string,
  rowId: string,
  mediaItemId: string,
  position: number
): SubsplashListRow => ({
  id: rowId,
  app_key: '9XTSHD',
  method: 'static',
  position,
  type: 'media-item',
  _embedded: {
    'source-list': { id: listId },
    'media-item': { id: mediaItemId },
  },
});

const createOverflowRow = (
  listId: string,
  rowId: string,
  linkedListId: string,
  position: number
): SubsplashListRow => ({
  id: rowId,
  app_key: '9XTSHD',
  method: 'static',
  position,
  type: 'list',
  _embedded: {
    'source-list': { id: listId },
    list: { id: linkedListId },
  },
});

const getRowIdentity = (row: SubsplashListRow): string =>
  row.type === 'list' ? `list:${row._embedded.list?.id}` : `media:${row._embedded['media-item']?.id}`;

describe('reorderListItems', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    networkFailureInjector.clear();
  });

  it('repartitions a logical overflow chain across physical pages while preserving continuation links', async () => {
    const rootSubsplashListId = 'subsplash-root-list';
    const overflowSubsplashListId = 'subsplash-overflow-list';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 4);
    subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 4);
    subsplashMock.listRows.set(rootSubsplashListId, [
      createMediaRow(rootSubsplashListId, 'row-a', 'media-a', 1),
      createMediaRow(rootSubsplashListId, 'row-b', 'media-b', 2),
      createMediaRow(rootSubsplashListId, 'row-c', 'media-c', 3),
      createOverflowRow(rootSubsplashListId, 'row-link', overflowSubsplashListId, 4),
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-d', 'media-d', 1),
      createMediaRow(overflowSubsplashListId, 'row-e', 'media-e', 2),
    ]);

    const rootFirestoreListId = await createListDocument({
      id: 'root-list',
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      logicalCount: 5,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-list',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'overflow-list',
      subsplashId: overflowSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-list',
      overflowDepth: 1,
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: [
          { mediaItemId: 'media-d', position: 1 },
          { mediaItemId: 'media-a', position: 2 },
          { mediaItemId: 'media-b', position: 3 },
          { mediaItemId: 'media-c', position: 4 },
          { mediaItemId: 'media-e', position: 5 },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'success',
      rootListId: 'root-list',
      subsplashListId: rootSubsplashListId,
      assignments: [
        {
          mediaItemId: 'media-d',
          firestoreListId: 'root-list',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          position: 1,
        },
        {
          mediaItemId: 'media-a',
          firestoreListId: 'root-list',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          position: 2,
        },
        {
          mediaItemId: 'media-b',
          firestoreListId: 'root-list',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          position: 3,
        },
        {
          mediaItemId: 'media-c',
          firestoreListId: 'overflow-list',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          position: 1,
        },
        {
          mediaItemId: 'media-e',
          firestoreListId: 'overflow-list',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          position: 2,
        },
      ],
    });

    const rootRows = subsplashMock.getListRows(rootSubsplashListId);
    expect(rootRows.map(getRowIdentity)).toEqual([
      'media:media-d',
      'media:media-a',
      'media:media-b',
      `list:${overflowSubsplashListId}`,
    ]);
    expect(rootRows[3].id).toBe('row-link');

    const overflowRows = subsplashMock.getListRows(overflowSubsplashListId);
    expect(overflowRows.map(getRowIdentity)).toEqual(['media:media-c', 'media:media-e']);
  });

  it('returns success when there are no synced items to reorder', async () => {
    const subsplashListId = 'subsplash-list-empty';
    subsplashMock.createList(subsplashListId, 'Empty List');

    const rootListId = await createListDocument({
      id: 'root-empty-list',
      subsplashId: subsplashListId,
      title: 'Empty List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 0,
      isRootList: true,
      rootListId: 'root-empty-list',
      overflowDepth: 0,
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId,
        logicalItemOrder: [],
      },
    });

    expect(result).toEqual({
      status: 'success',
      message: 'No items to reorder.',
      rootListId,
      subsplashListId,
      assignments: [],
    });
  });

  it('blocks reorder before remote writes when the chain audit reports blocking issues', async () => {
    const rootSubsplashListId = 'broken-root-subsplash';
    const overflowSubsplashListId = 'broken-overflow-subsplash';
    subsplashMock.createList(rootSubsplashListId, 'Broken Root List', 0, 4);
    subsplashMock.createList(overflowSubsplashListId, 'More Broken Root List sermons', 0, 4);
    subsplashMock.listRows.set(rootSubsplashListId, [
      createMediaRow(rootSubsplashListId, 'row-a', 'media-a', 1),
      createOverflowRow(rootSubsplashListId, 'row-link', overflowSubsplashListId, 2),
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-b', 'media-b', 1),
    ]);

    await createListDocument({
      id: 'broken-root-list',
      subsplashId: rootSubsplashListId,
      title: 'Broken Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      logicalCount: 2,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'broken-overflow-list',
      subsplashId: overflowSubsplashListId,
      title: 'More Broken Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      moreSermonsRef: 'missing-overflow-subsplash',
    });

    const patchSpy = jest.spyOn(subsplashMock, 'patchList');

    await expect(
      reorderListItemsHandler({
        auth: { token: { role: 'admin' } },
        data: {
          rootListId: 'broken-root-list',
          logicalItemOrder: [
            { mediaItemId: 'media-a', position: 1 },
            { mediaItemId: 'media-b', position: 2 },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects payloads that do not cover the full synced overflow chain', async () => {
    const subsplashListId = 'subsplash-list-missing';
    subsplashMock.createList(subsplashListId, 'Missing Item List');
    subsplashMock.listRows.set(subsplashListId, [
      createMediaRow(subsplashListId, 'row-a', 'media-a', 1),
    ]);

    await createListDocument({
      id: 'missing-item-root',
      subsplashId: subsplashListId,
      title: 'Missing Item List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      logicalCount: 1,
      isRootList: true,
      rootListId: 'missing-item-root',
      overflowDepth: 0,
    });

    await expect(
      reorderListItemsHandler({
        auth: { token: { role: 'admin' } },
        data: {
          rootListId: 'missing-item-root',
          logicalItemOrder: [{ mediaItemId: 'media-b', position: 1 }],
        },
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});
