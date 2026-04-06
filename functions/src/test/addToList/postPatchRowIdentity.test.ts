import { OverflowBehavior } from '@upperroom/shared/types/List';
import { SubsplashListRow } from '../../types/Subsplash';
import {
  subsplashMock,
  TestRequest,
  AddToListHandler,
} from './mocks';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';

jest.mock('../../helpers/publishedListDrift', () => {
  const actual = jest.requireActual('../../helpers/publishedListDrift');
  return {
    ...actual,
    ensureCanPerformStrictPublishedMutation: jest.fn().mockResolvedValue(undefined),
  };
});

const addToListHandler = addToList as unknown as AddToListHandler;

const createMediaRow = (listId: string, mediaId: string, position: number): SubsplashListRow => ({
  id: `row-${listId}-${mediaId}`,
  app_key: '9XTSHD',
  method: 'static',
  position,
  type: 'media-item',
  _embedded: {
    'source-list': { id: listId },
    'media-item': { id: mediaId },
  },
});

const createListLinkRow = (sourceListId: string, targetListId: string, position: number): SubsplashListRow => ({
  id: `row-${sourceListId}-link-${targetListId}`,
  app_key: '9XTSHD',
  method: 'static',
  position,
  type: 'list',
  _embedded: {
    'source-list': { id: sourceListId },
    list: { id: targetListId },
  },
});

describe('addToList - post-patch row identity', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 5;
  });

  it('keeps a stable listItemId when the first list-rows fetch after an overflow patch is stale', async () => {
    const rootListId = 'post-patch-root-list';
    const overflowListId = 'post-patch-overflow-list';

    subsplashMock.createList(rootListId, 'Root List', 5, 5);
    subsplashMock.createList(overflowListId, 'More Root List', 0, 5);
    subsplashMock.listRows.set(rootListId, [
      createMediaRow(rootListId, 'sermon-1', 1),
      createMediaRow(rootListId, 'sermon-2', 2),
      createMediaRow(rootListId, 'sermon-3', 3),
      createMediaRow(rootListId, 'sermon-4', 4),
      createListLinkRow(rootListId, overflowListId, 5),
    ]);

    await createListDocument({
      id: 'root-firestore-list',
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
      count: 5,
      logicalCount: 4,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-firestore-list',
      overflowDepth: 0,
    });
    await createListDocument({
      id: 'overflow-firestore-list',
      subsplashId: overflowListId,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: 'root-firestore-list',
      overflowDepth: 1,
      count: 0,
    });

    subsplashMock.returnStaleListRowsAfterNextPatch(rootListId);

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'sermon-5', type: 'media-item' },
        maxListSize: 5,
        operationKey: 'post-patch-row-id-repro-1',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    if (result[0].status !== 'success') {
      throw new Error(`Expected success, received ${result[0].status}`);
    }
    expect(result[0].listItemId).toBeDefined();

    const rootRows = subsplashMock.getListRows(rootListId);
    expect(rootRows).toHaveLength(5);
    expect(rootRows[0]._embedded['media-item']?.id).toBe('sermon-5');
    expect(rootRows[0].id).toBe(result[0].listItemId);
    expect(rootRows[rootRows.length - 1].type).toBe('list');
    expect(rootRows[rootRows.length - 1]._embedded.list?.id).toBe(overflowListId);

    const overflowRows = subsplashMock.getListRows(overflowListId);
    expect(overflowRows.map((row) => row._embedded['media-item']?.id)).toContain('sermon-4');
  });

  it('keeps successive overflow adds attached to the chain when each immediate post-patch read is stale', async () => {
    const rootListId = 'post-patch-chain-root-list';
    const overflowListId = 'post-patch-chain-overflow-list';

    subsplashMock.createList(rootListId, 'Chain Root List', 5, 5);
    subsplashMock.createList(overflowListId, 'More Chain Root List', 0, 5);
    subsplashMock.listRows.set(rootListId, [
      createMediaRow(rootListId, 'seed-1', 1),
      createMediaRow(rootListId, 'seed-2', 2),
      createMediaRow(rootListId, 'seed-3', 3),
      createMediaRow(rootListId, 'seed-4', 4),
      createListLinkRow(rootListId, overflowListId, 5),
    ]);

    await createListDocument({
      id: 'chain-root-firestore-list',
      subsplashId: rootListId,
      title: 'Chain Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
      count: 5,
      logicalCount: 4,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'chain-root-firestore-list',
      overflowDepth: 0,
    });
    await createListDocument({
      id: 'chain-overflow-firestore-list',
      subsplashId: overflowListId,
      title: 'More Chain Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: 'chain-root-firestore-list',
      overflowDepth: 1,
      count: 0,
    });

    const addedIds = ['rapid-1', 'rapid-2', 'rapid-3'];
    const results = [];

    for (const mediaItemId of addedIds) {
      subsplashMock.returnStaleListRowsAfterNextPatch(rootListId);
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootListId],
          mediaItem: { id: mediaItemId, type: 'media-item' },
          maxListSize: 5,
          operationKey: `post-patch-row-id-chain-${mediaItemId}`,
        },
      };

      results.push(await addToListHandler(request));
    }

    results.forEach((result) => {
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status !== 'success') {
        throw new Error(`Expected success, received ${result[0].status}`);
      }
      expect(result[0].listItemId).toBeDefined();
    });

    const rootRows = subsplashMock.getListRows(rootListId);
    expect(rootRows.map((row) => row._embedded['media-item']?.id)).toEqual(['rapid-3', 'rapid-2', 'rapid-1', 'seed-1', undefined]);
    expect(rootRows[rootRows.length - 1].type).toBe('list');

    const overflowRows = subsplashMock.getListRows(overflowListId);
    expect(overflowRows.map((row) => row._embedded['media-item']?.id)).toEqual(['seed-2', 'seed-3', 'seed-4']);
  });

  it('recovers when several immediate post-patch reads are stale before the new row becomes visible', async () => {
    const rootListId = 'post-patch-retry-root-list';
    const overflowListId = 'post-patch-retry-overflow-list';

    subsplashMock.createList(rootListId, 'Retry Root List', 2, 3);
    subsplashMock.createList(overflowListId, 'More Retry Root List', 0, 3);
    subsplashMock.listRows.set(rootListId, [
      createMediaRow(rootListId, 'seed-1', 1),
      createListLinkRow(rootListId, overflowListId, 2),
    ]);

    await createListDocument({
      id: 'retry-root-firestore-list',
      subsplashId: rootListId,
      title: 'Retry Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
      count: 2,
      logicalCount: 1,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'retry-root-firestore-list',
      overflowDepth: 0,
    });
    await createListDocument({
      id: 'retry-overflow-firestore-list',
      subsplashId: overflowListId,
      title: 'More Retry Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: 'retry-root-firestore-list',
      overflowDepth: 1,
      count: 0,
    });

    subsplashMock.returnStaleListRowsAfterNextPatch(rootListId, 4);

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'sermon-retry', type: 'media-item' },
        maxListSize: 3,
        operationKey: 'post-patch-row-id-retry-1',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    if (result[0].status !== 'success') {
      throw new Error(`Expected success, received ${result[0].status}`);
    }
    expect(result[0].listItemId).toBeDefined();

    let rootRows = subsplashMock.getListRows(rootListId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      rootRows = subsplashMock.getListRows(rootListId);
    }
    const mediaIds = rootRows.map((row) => row._embedded['media-item']?.id);
    expect(mediaIds).toEqual(expect.arrayContaining(['sermon-retry', 'seed-1']));
  });

  it('recovers from longer stale post-patch reads by retrying overflow-chain placement lookup', async () => {
    const rootListId = 'post-patch-chain-recovery-root-list';
    const overflowListId = 'post-patch-chain-recovery-overflow-list';

    subsplashMock.createList(rootListId, 'Chain Recovery Root List', 2, 3);
    subsplashMock.createList(overflowListId, 'More Chain Recovery Root List', 0, 3);
    subsplashMock.listRows.set(rootListId, [
      createMediaRow(rootListId, 'seed-1', 1),
      createListLinkRow(rootListId, overflowListId, 2),
    ]);

    await createListDocument({
      id: 'chain-recovery-root-firestore-list',
      subsplashId: rootListId,
      title: 'Chain Recovery Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
      count: 2,
      logicalCount: 1,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'chain-recovery-root-firestore-list',
      overflowDepth: 0,
    });
    await createListDocument({
      id: 'chain-recovery-overflow-firestore-list',
      subsplashId: overflowListId,
      title: 'More Chain Recovery Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: 'chain-recovery-root-firestore-list',
      overflowDepth: 1,
      count: 0,
    });

    subsplashMock.returnStaleListRowsAfterNextPatch(rootListId, 6);

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'sermon-chain-recovery', type: 'media-item' },
        maxListSize: 3,
        operationKey: 'post-patch-chain-recovery-1',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    if (result[0].status !== 'success') {
      throw new Error(`Expected success, received ${result[0].status}`);
    }
    expect(result[0].listItemId).toBeDefined();

    const rootRows = subsplashMock.getListRows(rootListId);
    expect(rootRows.map((row) => row._embedded['media-item']?.id)).toEqual(
      expect.arrayContaining(['sermon-chain-recovery', 'seed-1'])
    );
  });
});
