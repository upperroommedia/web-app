import { OverflowBehavior } from '@upperroom/shared/types/List';
import { networkFailureInjector, subsplashMock } from '../addToList/mocks';
import reorderListItems, {
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../reorderListItems';
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

describe('reorderListItems', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    networkFailureInjector.clear();
  });

  it('reorders media items while preserving non-target rows in place', async () => {
    const subsplashListId = 'subsplash-list-1';
    subsplashMock.createList(subsplashListId, 'Test List');
    subsplashMock.listRows.set(subsplashListId, [
      createMediaRow(subsplashListId, 'row-a', 'media-a', 1),
      createOverflowRow(subsplashListId, 'row-overflow', 'overflow-list-1', 2),
      createMediaRow(subsplashListId, 'row-b', 'media-b', 3),
    ]);

    const firestoreListId = await createListDocument({
      subsplashId: subsplashListId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        firestoreListId,
        itemOrder: [
          { mediaItemId: 'media-b', position: 1 },
          { mediaItemId: 'media-a', position: 2 },
        ],
      },
    });

    expect(result.status).toBe('success');

    const rows = subsplashMock.getListRows(subsplashListId);
    expect(rows.map((row) => row.id)).toEqual(['row-b', 'row-overflow', 'row-a']);
    expect(rows[1].type).toBe('list');
    expect(rows[1]._embedded.list?.id).toBe('overflow-list-1');
  });

  it('returns success when there are no items to reorder', async () => {
    const subsplashListId = 'subsplash-list-empty';
    subsplashMock.createList(subsplashListId, 'Empty List');

    const firestoreListId = await createListDocument({
      subsplashId: subsplashListId,
      title: 'Empty List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        firestoreListId,
        itemOrder: [],
      },
    });

    expect(result.status).toBe('success');
  });

  it('rejects requests for media items that are not in the remote list', async () => {
    const subsplashListId = 'subsplash-list-missing';
    subsplashMock.createList(subsplashListId, 'Missing Item List');
    subsplashMock.listRows.set(subsplashListId, [
      createMediaRow(subsplashListId, 'row-a', 'media-a', 1),
    ]);

    const firestoreListId = await createListDocument({
      subsplashId: subsplashListId,
      title: 'Missing Item List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
    });

    await expect(
      reorderListItemsHandler({
        auth: { token: { role: 'admin' } },
        data: {
          firestoreListId,
          itemOrder: [{ mediaItemId: 'media-b', position: 1 }],
        },
      })
    ).rejects.toThrow();
  });
});
