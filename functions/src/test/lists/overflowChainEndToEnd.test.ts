import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import {
  AddToListHandler,
  subsplashMock,
  TestRequest as AddToListTestRequest,
} from '../addToList/mocks';
import addToList from '../../addToList';
import reorderListItems from '../../reorderListItems';
import removeFromList from '../../removeFromList';
import { getOverflowChainState, syncOverflowChainMetadata } from '../../helpers/listOverflowChain';
import { clearFirestore, createListDocument, createSermonDocument } from '../addToList/firestoreHelpers';
import type {
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../../../packages/contracts/reorderListItems';
import type { RemoveFromListInputType, RemoveFromListOutputType } from '../../removeFromList';

type ReorderTestRequest = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: ReorderListItemsInputType;
};

type ReorderListItemsHandler = (
  request: ReorderTestRequest
) => Promise<ReorderListItemsOutputType>;

type RemoveFromListTestRequest = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: RemoveFromListInputType;
};

type RemoveFromListHandler = (
  request: RemoveFromListTestRequest
) => Promise<RemoveFromListOutputType>;

type ChainPageSummary = {
  subsplashListId: string;
  mediaIds: string[];
  linkTarget: string | null;
};

const assertSubsplashHistoryNeverExceedsCapacity = (maxListSize: number) => {
  subsplashMock.getHistory().forEach((entry) => {
    const mediaRows = entry.rows.filter((row) => row.type !== 'list');
    const linkRows = entry.rows.filter((row) => row.type === 'list');
    const maxContentCount = linkRows.length > 0 ? maxListSize - 1 : maxListSize;

    expect(mediaRows.length).toBeLessThanOrEqual(maxContentCount);

    if (linkRows.length > 0) {
      expect(linkRows).toHaveLength(1);
      expect(entry.rows[entry.rows.length - 1].type).toBe('list');
    }
  });
};

const firestore = firebaseAdmin.firestore();
const addToListHandler = addToList as unknown as AddToListHandler;
const reorderListItemsHandler = reorderListItems as unknown as ReorderListItemsHandler;
const removeFromListHandler = removeFromList as unknown as RemoveFromListHandler;
const ROOT_TITLE = 'Root Sermon List';

const buildSermonId = (index: number): string => `sermon-${index}`;

const buildExpectedPages = (mediaIds: string[], maxListSize: number): string[][] => {
  const pages: string[][] = [];
  let cursor = 0;

  while (cursor < mediaIds.length) {
    const remaining = mediaIds.length - cursor;
    const pageSize = remaining > maxListSize ? maxListSize - 1 : remaining;
    pages.push(mediaIds.slice(cursor, cursor + pageSize));
    cursor += pageSize;
  }

  return pages;
};

const getChainPageSummaries = (rootSubsplashListId: string): ChainPageSummary[] => {
  const pages: ChainPageSummary[] = [];
  const visited = new Set<string>();
  let currentListId: string | null = rootSubsplashListId;

  while (currentListId) {
    if (visited.has(currentListId)) {
      throw new Error(`Cycle detected while traversing mock Subsplash chain at ${currentListId}`);
    }

    visited.add(currentListId);

    const rows = subsplashMock.getListRows(currentListId);
    const mediaIds = rows
      .filter((row) => row.type === 'media-item')
      .map((row) => row._embedded['media-item']?.id)
      .filter((value): value is string => Boolean(value));
    const linkRow = rows.find((row) => row.type === 'list' && row._embedded.list?.id);
    const linkTarget = linkRow?._embedded.list?.id ?? null;

    pages.push({
      subsplashListId: currentListId,
      mediaIds,
      linkTarget,
    });

    currentListId = linkTarget;
  }

  return pages;
};

const flattenChainMediaIds = (rootSubsplashListId: string): string[] =>
  getChainPageSummaries(rootSubsplashListId).flatMap((page) => page.mediaIds);

const getMediaLocation = (
  rootSubsplashListId: string,
  mediaItemId: string
): { subsplashListId: string; rowId: string } => {
  const pages = getChainPageSummaries(rootSubsplashListId);

  for (const page of pages) {
    const rows = subsplashMock.getListRows(page.subsplashListId);
    const matchingRow = rows.find((row) => row._embedded[row.type]?.id === mediaItemId);
    if (matchingRow?.id) {
      return {
        subsplashListId: page.subsplashListId,
        rowId: matchingRow.id,
      };
    }
  }

  throw new Error(`Media item ${mediaItemId} was not found in the mock Subsplash chain.`);
};

const loadListDocData = async (firestoreListId: string): Promise<Record<string, unknown>> => {
  const snapshot = await firestore.collection('lists').doc(firestoreListId).get();
  if (!snapshot.exists) {
    throw new Error(`Expected Firestore list ${firestoreListId} to exist.`);
  }

  return snapshot.data() as Record<string, unknown>;
};

const assertChainMatches = async (
  rootFirestoreListId: string,
  rootSubsplashListId: string,
  expectedOrder: string[],
  maxListSize: number,
  expectedPagesOverride?: string[][]
) => {
  const chainState = await getOverflowChainState(rootFirestoreListId);
  expect(chainState.canMutate).toBe(true);
  expect(chainState.issues).toEqual([]);

  const pageSummaries = getChainPageSummaries(rootSubsplashListId);
  const expectedPages = expectedPagesOverride ?? buildExpectedPages(expectedOrder, maxListSize);

  expect(flattenChainMediaIds(rootSubsplashListId)).toEqual(expectedOrder);
  expect(pageSummaries.map((page) => page.mediaIds)).toEqual(expectedPages);
  expect(chainState.logicalCount).toBe(expectedOrder.length);
  expect(chainState.nodes).toHaveLength(expectedPages.length);

  for (let index = 0; index < expectedPages.length; index += 1) {
    const page = pageSummaries[index];
    const node = chainState.nodes[index];
    const expectedPageMediaIds = expectedPages[index];
    const isTail = index === expectedPages.length - 1;
    const list = subsplashMock.getList(page.subsplashListId);
    const rawRows = subsplashMock.getListRows(page.subsplashListId);

    expect(node.subsplashId).toBe(page.subsplashListId);
    expect(node.depth).toBe(index);
    expect(node.count).toBe(expectedPageMediaIds.length);
    expect(rawRows.filter((row) => row.type === 'media-item')).toHaveLength(expectedPageMediaIds.length);
    expect(rawRows.some((row) => row.type === 'list')).toBe(!isTail);
    expect(page.linkTarget).toBe(isTail ? null : pageSummaries[index + 1].subsplashListId);
    expect(list?.title).toBe(index === 0 ? ROOT_TITLE : `More ${ROOT_TITLE} sermons`);
    expect(list?.subtitle).toBe(index === 0 ? undefined : `Page ${index}`);

    if (!isTail) {
      expect(rawRows).toHaveLength(expectedPageMediaIds.length + 1);
    }

    const docData = await loadListDocData(node.firestoreListId);
    expect(docData.count).toBe(expectedPageMediaIds.length);
    expect(docData.isRootList).toBe(index === 0);
    expect(docData.isMoreSermonsList).toBe(index > 0);
    expect(docData.rootListId).toBe(rootFirestoreListId);
    expect(docData.overflowDepth).toBe(index);
    expect(docData.name).toBe(index === 0 ? ROOT_TITLE : `More ${ROOT_TITLE} sermons`);

    if (index === 0) {
      expect(docData.logicalCount).toBe(expectedOrder.length);
      expect(docData.hasOverflowPages).toBe(expectedPages.length > 1);
      expect(docData.moreSermonsRef).toBe(isTail ? undefined : pageSummaries[index + 1].subsplashListId);
    } else if (isTail) {
      expect(docData.moreSermonsRef).toBeUndefined();
    } else {
      expect(docData.moreSermonsRef).toBe(pageSummaries[index + 1].subsplashListId);
    }
  }

  return {
    chainState,
    pageSummaries,
    expectedPages,
  };
};

const seedPublishedProjectionFromCurrentChain = async ({
  rootFirestoreListId,
  chainState,
  pageSummaries,
}: {
  rootFirestoreListId: string;
  chainState: Awaited<ReturnType<typeof getOverflowChainState>>;
  pageSummaries: ChainPageSummary[];
}) => {
  const rootListSnapshot = await firestore.collection('lists').doc(rootFirestoreListId).get();
  const rootListData = rootListSnapshot.data() as Record<string, unknown>;
  let logicalPosition = 1;

  for (let pageIndex = 0; pageIndex < pageSummaries.length; pageIndex += 1) {
    const pageSummary = pageSummaries[pageIndex];
    const node = chainState.nodes[pageIndex];

    for (let mediaIndex = 0; mediaIndex < pageSummary.mediaIds.length; mediaIndex += 1) {
      const sermonId = pageSummary.mediaIds[mediaIndex];
      const location = getMediaLocation(pageSummaries[0].subsplashListId, sermonId);

      await createSermonDocument({
        id: sermonId,
        title: sermonId,
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now(),
        sourceStartTime: 0,
        durationSeconds: 1_000,
        topics: [],
        status: {
          subsplash: uploadStatus.UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now(),
        editedAtMillis: Date.now(),
        subsplashId: sermonId,
      });

      await firestore.collection('lists').doc(rootFirestoreListId).collection('listItems').doc(sermonId).set({
        id: sermonId,
        title: sermonId,
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now(),
        sourceStartTime: 0,
        durationSeconds: 1_000,
        topics: [],
        status: {
          subsplash: uploadStatus.UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now(),
        editedAtMillis: Date.now(),
        subsplashId: sermonId,
        position: logicalPosition,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: location.rowId },
        physicalPlacement: {
          firestoreListId: node.firestoreListId,
          subsplashListId: pageSummary.subsplashListId,
          overflowDepth: pageIndex,
          position: mediaIndex + 1,
          listItemId: location.rowId,
        },
      });

      await firestore.collection('sermons').doc(sermonId).collection('sermonLists').doc(rootFirestoreListId).set({
        ...rootListData,
        id: rootFirestoreListId,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: location.rowId },
      });

      logicalPosition += 1;
    }
  }
};

const syncPublishedProjectionFromCurrentChain = async (
  rootFirestoreListId: string,
  rootSubsplashListId: string
) => {
  const chainState = await getOverflowChainState(rootFirestoreListId);
  const pageSummaries = getChainPageSummaries(rootSubsplashListId);
  await seedPublishedProjectionFromCurrentChain({
    rootFirestoreListId,
    chainState,
    pageSummaries,
  });
};

describe('overflow chain end-to-end regression', () => {
  beforeEach(async () => {
    await clearFirestore();
    await firebaseAdmin.database().ref('subsplashLocks').remove();
    subsplashMock.reset();
    subsplashMock.maxListSize = 5;
  });

  jest.setTimeout(120_000);

  it('builds a 13-sermon chain as 4 + link / 4 + link / 5 when maxListSize is 5', async () => {
    const maxListSize = 5;
    const rootSubsplashListId = 'root-thirteen-subsplash-list';
    const rootFirestoreListId = 'root-thirteen-firestore-list';

    subsplashMock.createList(rootSubsplashListId, ROOT_TITLE, 0, maxListSize);
    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: ROOT_TITLE,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      maxListSize,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    subsplashMock.clearHistory();

    for (let index = 1; index <= 13; index += 1) {
      const result = await addToListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootSubsplashListId],
          mediaItem: { id: buildSermonId(index), type: 'media-item' },
          maxListSize,
          operationKey: `overflow-thirteen:add:${index}`,
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      await syncPublishedProjectionFromCurrentChain(rootFirestoreListId, rootSubsplashListId);
    }

    await assertChainMatches(
      rootFirestoreListId,
      rootSubsplashListId,
      Array.from({ length: 13 }, (_, index) => buildSermonId(13 - index)),
      maxListSize,
      [
        ['sermon-13', 'sermon-12', 'sermon-11', 'sermon-10'],
        ['sermon-9', 'sermon-8', 'sermon-7', 'sermon-6'],
        ['sermon-5', 'sermon-4', 'sermon-3', 'sermon-2', 'sermon-1'],
      ]
    );
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);
  });

  it('rebalances a published 3-max chain after removing a root-page sermon and updates the root projection status', async () => {
    const maxListSize = 3;
    const previousMaxListSizeOverride = process.env.SUBSPLASH_DEV_MAX_LIST_SIZE;
    process.env.SUBSPLASH_DEV_MAX_LIST_SIZE = String(maxListSize);
    try {
      const rootSubsplashListId = 'remove-root-page-subsplash-list';
      const rootFirestoreListId = 'remove-root-page-firestore-list';

      subsplashMock.createList(rootSubsplashListId, ROOT_TITLE, 0, maxListSize);
      await createListDocument({
        id: rootFirestoreListId,
        subsplashId: rootSubsplashListId,
        title: ROOT_TITLE,
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        maxListSize,
        count: 0,
        logicalCount: 0,
        hasOverflowPages: false,
        isRootList: true,
        isMoreSermonsList: false,
        rootListId: rootFirestoreListId,
        overflowDepth: 0,
      });

      for (let index = 1; index <= 6; index += 1) {
        const result = await addToListHandler({
          auth: { token: { role: 'admin' } },
          data: {
            destinationListIds: [rootSubsplashListId],
            mediaItem: { id: buildSermonId(index), type: 'media-item' },
            maxListSize,
            operationKey: `remove-root-page:add:${index}`,
          },
        });

        expect(result[0].status).toBe('success');
        await syncPublishedProjectionFromCurrentChain(rootFirestoreListId, rootSubsplashListId);
      }

      const toRemove = buildSermonId(5);
      const rootLocation = getMediaLocation(rootSubsplashListId, toRemove);
      subsplashMock.clearHistory();

      const removeResult = await removeFromListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          listIds: [rootSubsplashListId],
          listItemIds: [rootLocation.rowId],
          itemIds: [toRemove],
          itemTypes: ['media-item'],
          operationKey: 'remove-root-page:remove:5',
        },
      });

      expect(removeResult[0].status).toBe('success');
      assertSubsplashHistoryNeverExceedsCapacity(maxListSize);

      const expectedOrder = [
        buildSermonId(6),
        buildSermonId(4),
        buildSermonId(3),
        buildSermonId(2),
        buildSermonId(1),
      ];
      await assertChainMatches(
        rootFirestoreListId,
        rootSubsplashListId,
        expectedOrder,
        maxListSize,
        [[buildSermonId(6), buildSermonId(4)], [buildSermonId(3), buildSermonId(2), buildSermonId(1)]]
      );

      const removedProjection = await firestore
        .collection('lists')
        .doc(rootFirestoreListId)
        .collection('listItems')
        .doc(toRemove)
        .get();
      expect(removedProjection.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
      expect(removedProjection.data()?.physicalPlacement).toBeUndefined();

      const promotedProjection = await firestore
        .collection('lists')
        .doc(rootFirestoreListId)
        .collection('listItems')
        .doc(buildSermonId(4))
        .get();
      expect(promotedProjection.data()?.uploadStatus?.status).toBe(uploadStatus.UPLOADED);
      expect(promotedProjection.data()?.physicalPlacement).toMatchObject({
        firestoreListId: rootFirestoreListId,
        overflowDepth: 0,
        position: 2,
      });
    } finally {
      if (previousMaxListSizeOverride) {
        process.env.SUBSPLASH_DEV_MAX_LIST_SIZE = previousMaxListSizeOverride;
      } else {
        delete process.env.SUBSPLASH_DEV_MAX_LIST_SIZE;
      }
    }
  });

  it('keeps mock Subsplash pages and Firestore overflow metadata aligned across add, reorder, and delete flows', async () => {
    const maxListSize = 5;
    const rootSubsplashListId = 'root-subsplash-list';
    const rootFirestoreListId = 'root-firestore-list';

    subsplashMock.createList(rootSubsplashListId, ROOT_TITLE, 0, maxListSize);
    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: ROOT_TITLE,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      maxListSize,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    for (let index = 1; index <= 50; index += 1) {
      const request: AddToListTestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootSubsplashListId],
          mediaItem: { id: buildSermonId(index), type: 'media-item' },
          maxListSize,
          operationKey: `overflow-e2e:add:${index}`,
        },
      };

      const result = await addToListHandler(request);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
      }
      await syncPublishedProjectionFromCurrentChain(rootFirestoreListId, rootSubsplashListId);
    }

    const descendingOrder = Array.from({ length: 50 }, (_, index) => buildSermonId(50 - index));
    await assertChainMatches(
      rootFirestoreListId,
      rootSubsplashListId,
      descendingOrder,
      maxListSize
    );
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);

    const ascendingOrder = Array.from({ length: 50 }, (_, index) => buildSermonId(index + 1));
    subsplashMock.clearHistory();
    const reorderResult = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: ascendingOrder.map((mediaItemId, index) => ({
          mediaItemId,
          position: index + 1,
        })),
        operationKey: 'overflow-e2e:reorder:ascending',
      },
    });

    expect(reorderResult.status).toBe('success');
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);
    expect(reorderResult.assignments).toHaveLength(50);

    const reorderedState = await assertChainMatches(
      rootFirestoreListId,
      rootSubsplashListId,
      ascendingOrder,
      maxListSize
    );

    const expectedAssignments = reorderedState.expectedPages.flatMap((pageMediaIds, pageIndex) =>
      pageMediaIds.map((mediaItemId, mediaIndex) => ({
        mediaItemId,
        firestoreListId: reorderedState.chainState.nodes[pageIndex].firestoreListId,
        subsplashListId: reorderedState.pageSummaries[pageIndex].subsplashListId,
        overflowDepth: pageIndex,
        position: mediaIndex + 1,
      }))
    );
    expect(reorderResult.assignments).toEqual(expectedAssignments);

    const frontLocation = getMediaLocation(rootSubsplashListId, buildSermonId(1));
    subsplashMock.clearHistory();
    const frontDeleteResult = await removeFromListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [frontLocation.subsplashListId],
        listItemIds: [frontLocation.rowId],
        itemIds: [buildSermonId(1)],
        itemTypes: ['media-item'],
        operationKey: 'overflow-e2e:remove:front',
      },
    });
    expect(frontDeleteResult[0].status).toBe('success');
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);

    subsplashMock.clearHistory();
    const middleDeleteResult = await removeFromListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootSubsplashListId],
        listItemIds: ['missing-sermon-25-row'],
        itemIds: [buildSermonId(25)],
        itemTypes: ['media-item'],
        operationKey: 'overflow-e2e:remove:middle',
      },
    });
    expect(middleDeleteResult[0].status).toBe('success');
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);

    subsplashMock.clearHistory();
    const endDeleteResult = await removeFromListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootSubsplashListId],
        listItemIds: ['missing-sermon-50-row'],
        itemIds: [buildSermonId(50)],
        itemTypes: ['media-item'],
        operationKey: 'overflow-e2e:remove:end',
      },
    });
    expect(endDeleteResult[0].status).toBe('success');
    assertSubsplashHistoryNeverExceedsCapacity(maxListSize);

    const expectedAfterDeletes = ascendingOrder.filter(
      (mediaItemId) =>
        mediaItemId !== buildSermonId(1) &&
        mediaItemId !== buildSermonId(25) &&
        mediaItemId !== buildSermonId(50)
    );
    const afterDeletesState = await assertChainMatches(
      rootFirestoreListId,
      rootSubsplashListId,
      expectedAfterDeletes,
      maxListSize
    );

    expect(afterDeletesState.pageSummaries[0].mediaIds).toEqual([
      buildSermonId(2),
      buildSermonId(3),
      buildSermonId(4),
      buildSermonId(5),
    ]);
    expect(afterDeletesState.pageSummaries[5].mediaIds).toEqual([
      buildSermonId(22),
      buildSermonId(23),
      buildSermonId(24),
      buildSermonId(26),
    ]);
    expect(afterDeletesState.pageSummaries[11].mediaIds).toEqual([
      buildSermonId(47),
      buildSermonId(48),
      buildSermonId(49),
    ]);
  });

  it('collapses an empty tail overflow page without throwing and clears the parent link', async () => {
    const rootSubsplashListId = 'collapse-root-list';
    const tailSubsplashListId = 'collapse-tail-list';

    subsplashMock.createList(rootSubsplashListId, ROOT_TITLE, 2, 5);
    subsplashMock.createList(tailSubsplashListId, `More ${ROOT_TITLE} sermons`, 0, 5, 'Page 1');
    subsplashMock.listRows.set(rootSubsplashListId, [
      {
        id: 'collapse-root-media-row',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: buildSermonId(1) },
        },
      },
      {
        id: 'collapse-root-link-row',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'list',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          list: { id: tailSubsplashListId },
        },
      },
    ]);
    subsplashMock.listRows.set(tailSubsplashListId, []);

    const rootFirestoreListId = await createListDocument({
      subsplashId: rootSubsplashListId,
      title: ROOT_TITLE,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      maxListSize: 5,
      count: 1,
      logicalCount: 1,
      hasOverflowPages: true,
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: 'placeholder',
      overflowDepth: 0,
      moreSermonsRef: tailSubsplashListId,
    });
    await firestore.collection('lists').doc(rootFirestoreListId).set({ rootListId: rootFirestoreListId }, { merge: true });

    const tailFirestoreListId = await createListDocument({
      subsplashId: tailSubsplashListId,
      title: `More ${ROOT_TITLE} sermons`,
      name: `More ${ROOT_TITLE} sermons`,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      maxListSize: 5,
      count: 0,
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 1,
    });

    await expect(syncOverflowChainMetadata(rootSubsplashListId, 'fake-token')).resolves.toBeUndefined();

    const rootRowsAfterCollapse = subsplashMock.getListRows(rootSubsplashListId);
    expect(rootRowsAfterCollapse).toHaveLength(1);
    expect(rootRowsAfterCollapse[0].type).toBe('media-item');

    const rootDocAfterCollapse = await firestore.collection('lists').doc(rootFirestoreListId).get();
    expect(rootDocAfterCollapse.get('moreSermonsRef')).toBeUndefined();

    const chainState = await getOverflowChainState(rootFirestoreListId);
    expect(chainState.nodes).toHaveLength(1);
    expect(chainState.nodes[0].firestoreListId).toBe(rootFirestoreListId);

    const tailDoc = await firestore.collection('lists').doc(tailFirestoreListId).get();
    expect(tailDoc.exists).toBe(true);
  });
});
