import { OverflowBehavior } from '@upperroom/shared/types/List';
import { networkFailureInjector, subsplashMock } from '../addToList/mocks';
import reorderListItems from '../../reorderListItems';
import { auditPublishedListDrift } from '../../helpers/publishedListDrift';
import type {
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../../../packages/contracts/reorderListItems';
import { createListDocument, clearFirestore } from '../addToList/firestoreHelpers';
import { SubsplashListRow } from '../../types/Subsplash';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';

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
const firestore = firebaseAdmin.firestore();

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

const seedThirteenOverflowFixture = async () => {
  const rootSubsplashListId = 'thirteen-root';
  const overflowSubsplashListId = 'thirteen-overflow';
  const tailSubsplashListId = 'thirteen-tail';
  const rootFirestoreListId = 'thirteen-root-firestore';

  subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 5);
  subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 5);
  subsplashMock.createList(tailSubsplashListId, 'More Root List sermons', 0, 5);

  subsplashMock.listRows.set(rootSubsplashListId, [
    createMediaRow(rootSubsplashListId, 'row-1', 'media-1', 1),
    createMediaRow(rootSubsplashListId, 'row-2', 'media-2', 2),
    createMediaRow(rootSubsplashListId, 'row-3', 'media-3', 3),
    createMediaRow(rootSubsplashListId, 'row-4', 'media-4', 4),
    createOverflowRow(rootSubsplashListId, 'row-link-1', overflowSubsplashListId, 5),
  ]);
  subsplashMock.listRows.set(overflowSubsplashListId, [
    createMediaRow(overflowSubsplashListId, 'row-5', 'media-5', 1),
    createMediaRow(overflowSubsplashListId, 'row-6', 'media-6', 2),
    createMediaRow(overflowSubsplashListId, 'row-7', 'media-7', 3),
    createMediaRow(overflowSubsplashListId, 'row-8', 'media-8', 4),
    createOverflowRow(overflowSubsplashListId, 'row-link-2', tailSubsplashListId, 5),
  ]);
  subsplashMock.listRows.set(tailSubsplashListId, [
    createMediaRow(tailSubsplashListId, 'row-9', 'media-9', 1),
    createMediaRow(tailSubsplashListId, 'row-10', 'media-10', 2),
    createMediaRow(tailSubsplashListId, 'row-11', 'media-11', 3),
    createMediaRow(tailSubsplashListId, 'row-12', 'media-12', 4),
    createMediaRow(tailSubsplashListId, 'row-13', 'media-13', 5),
  ]);

  await createListDocument({
    id: rootFirestoreListId,
    subsplashId: rootSubsplashListId,
    title: 'Root List',
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    count: 4,
    logicalCount: 13,
    hasOverflowPages: true,
    isRootList: true,
    rootListId: rootFirestoreListId,
    overflowDepth: 0,
    moreSermonsRef: overflowSubsplashListId,
  });
  await createListDocument({
    id: 'thirteen-overflow-firestore',
    subsplashId: overflowSubsplashListId,
    title: 'More Root List sermons',
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    count: 4,
    isMoreSermonsList: true,
    isRootList: false,
    rootListId: rootFirestoreListId,
    overflowDepth: 1,
    moreSermonsRef: tailSubsplashListId,
  });
  await createListDocument({
    id: 'thirteen-tail-firestore',
    subsplashId: tailSubsplashListId,
    title: 'More Root List sermons',
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    count: 5,
    isMoreSermonsList: true,
    isRootList: false,
    rootListId: rootFirestoreListId,
    overflowDepth: 2,
  });

  return {
    rootFirestoreListId,
    rootSubsplashListId,
    overflowSubsplashListId,
    tailSubsplashListId,
  };
};

const seedPublishedProjection = async ({
  rootFirestoreListId,
  assignments,
}: {
  rootFirestoreListId: string;
  assignments: Array<{
    firestoreListId: string;
    subsplashListId: string;
    overflowDepth: number;
    mediaIds: string[];
  }>;
}) => {
  const rootListSnapshot = await firestore.collection('lists').doc(rootFirestoreListId).get();
  const rootListData = rootListSnapshot.data() as Record<string, unknown>;
  let logicalPosition = 1;

  for (const assignment of assignments) {
    for (let index = 0; index < assignment.mediaIds.length; index += 1) {
      const mediaId = assignment.mediaIds[index];
      const sermonId = mediaId.replace('media', 'sermon');
      await firestore.collection('sermons').doc(sermonId).set({
        id: sermonId,
        title: sermonId,
        subtitle: '',
        description: '',
        speakers: [],
        date: firebaseAdmin.firestore.Timestamp.fromMillis(Date.now()),
        dateMillis: Date.now(),
        sourceStartTime: 0,
        durationSeconds: 1000,
        topics: [],
        status: {
          subsplash: uploadStatus.UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now(),
        editedAtMillis: Date.now(),
        subsplashId: mediaId,
      });
      await firestore.collection('lists').doc(rootFirestoreListId).collection('listItems').doc(sermonId).set({
        id: sermonId,
        title: sermonId,
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now(),
        sourceStartTime: 0,
        durationSeconds: 1000,
        topics: [],
        status: {
          subsplash: uploadStatus.UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now(),
        editedAtMillis: Date.now(),
        subsplashId: mediaId,
        position: logicalPosition,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: `row-${mediaId}` },
        physicalPlacement: {
          firestoreListId: assignment.firestoreListId,
          subsplashListId: assignment.subsplashListId,
          overflowDepth: assignment.overflowDepth,
          position: index + 1,
          listItemId: `row-${mediaId}`,
        },
      });
      await firestore.collection('sermons').doc(sermonId).collection('sermonLists').doc(rootFirestoreListId).set({
        ...rootListData,
        id: rootFirestoreListId,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: `row-${mediaId}` },
      });
      logicalPosition += 1;
    }
  }
};

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
    await seedPublishedProjection({
      rootFirestoreListId,
      assignments: [
        {
          firestoreListId: 'root-list',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-a', 'media-b', 'media-c'],
        },
        {
          firestoreListId: 'overflow-list',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-d', 'media-e'],
        },
      ],
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

  it('explicitly deletes rows moved off a page before patching so cross-boundary reorder cannot retain duplicates', async () => {
    const rootSubsplashListId = 'subsplash-root-realistic-patch';
    const overflowSubsplashListId = 'subsplash-overflow-realistic-patch';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 3);
    subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 3);
    subsplashMock.listRows.set(rootSubsplashListId, [
      createMediaRow(rootSubsplashListId, 'row-a', 'media-a', 1),
      createMediaRow(rootSubsplashListId, 'row-b', 'media-b', 2),
      createOverflowRow(rootSubsplashListId, 'row-link', overflowSubsplashListId, 3),
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-c', 'media-c', 1),
      createMediaRow(overflowSubsplashListId, 'row-d', 'media-d', 2),
      createMediaRow(overflowSubsplashListId, 'row-e', 'media-e', 3),
    ]);

    const rootFirestoreListId = await createListDocument({
      id: 'root-realistic-patch',
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      logicalCount: 5,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-realistic-patch',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'overflow-realistic-patch',
      subsplashId: overflowSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-realistic-patch',
      overflowDepth: 1,
    });
    await seedPublishedProjection({
      rootFirestoreListId,
      assignments: [
        {
          firestoreListId: 'root-realistic-patch',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-a', 'media-b'],
        },
        {
          firestoreListId: 'overflow-realistic-patch',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-c', 'media-d', 'media-e'],
        },
      ],
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: [
          { mediaItemId: 'media-a', position: 1 },
          { mediaItemId: 'media-d', position: 2 },
          { mediaItemId: 'media-b', position: 3 },
          { mediaItemId: 'media-c', position: 4 },
          { mediaItemId: 'media-e', position: 5 },
        ],
      },
    });

    expect(result.status).toBe('success');
    expect(subsplashMock.getListRows(rootSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-a',
      'media:media-d',
      `list:${overflowSubsplashListId}`,
    ]);
    expect(subsplashMock.getListRows(overflowSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-b',
      'media:media-c',
      'media:media-e',
    ]);
    assertSubsplashHistoryNeverExceedsCapacity(3);
  });

  it('preserves the existing page split even when Subsplash page capacity is larger than the logical overflow limit', async () => {
    const rootSubsplashListId = 'subsplash-root-large-capacity';
    const overflowSubsplashListId = 'subsplash-overflow-large-capacity';
    const tailSubsplashListId = 'subsplash-tail-large-capacity';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 200);
    subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 200);
    subsplashMock.createList(tailSubsplashListId, 'More Root List sermons', 0, 200);

    subsplashMock.listRows.set(rootSubsplashListId, [
      createMediaRow(rootSubsplashListId, 'row-a', 'media-a', 1),
      createMediaRow(rootSubsplashListId, 'row-b', 'media-b', 2),
      createOverflowRow(rootSubsplashListId, 'row-link-1', overflowSubsplashListId, 3),
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-c', 'media-c', 1),
      createMediaRow(overflowSubsplashListId, 'row-d', 'media-d', 2),
      createOverflowRow(overflowSubsplashListId, 'row-link-2', tailSubsplashListId, 3),
    ]);
    subsplashMock.listRows.set(tailSubsplashListId, [
      createMediaRow(tailSubsplashListId, 'row-e', 'media-e', 1),
      createMediaRow(tailSubsplashListId, 'row-f', 'media-f', 2),
    ]);

    const rootFirestoreListId = await createListDocument({
      id: 'root-large-capacity',
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      logicalCount: 6,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-large-capacity',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'overflow-large-capacity',
      subsplashId: overflowSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-large-capacity',
      overflowDepth: 1,
      moreSermonsRef: tailSubsplashListId,
    });
    await createListDocument({
      id: 'tail-large-capacity',
      subsplashId: tailSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-large-capacity',
      overflowDepth: 2,
    });
    await seedPublishedProjection({
      rootFirestoreListId,
      assignments: [
        {
          firestoreListId: 'root-large-capacity',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-a', 'media-b'],
        },
        {
          firestoreListId: 'overflow-large-capacity',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-c', 'media-d'],
        },
        {
          firestoreListId: 'tail-large-capacity',
          subsplashListId: tailSubsplashListId,
          overflowDepth: 2,
          mediaIds: ['media-e', 'media-f'],
        },
      ],
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: [
          { mediaItemId: 'media-f', position: 1 },
          { mediaItemId: 'media-e', position: 2 },
          { mediaItemId: 'media-d', position: 3 },
          { mediaItemId: 'media-c', position: 4 },
          { mediaItemId: 'media-b', position: 5 },
          { mediaItemId: 'media-a', position: 6 },
        ],
      },
    });

    expect(result.assignments).toEqual([
      expect.objectContaining({ mediaItemId: 'media-f', firestoreListId: 'root-large-capacity', overflowDepth: 0, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-e', firestoreListId: 'root-large-capacity', overflowDepth: 0, position: 2 }),
      expect.objectContaining({ mediaItemId: 'media-d', firestoreListId: 'overflow-large-capacity', overflowDepth: 1, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-c', firestoreListId: 'overflow-large-capacity', overflowDepth: 1, position: 2 }),
      expect.objectContaining({ mediaItemId: 'media-b', firestoreListId: 'tail-large-capacity', overflowDepth: 2, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-a', firestoreListId: 'tail-large-capacity', overflowDepth: 2, position: 2 }),
    ]);

    expect(subsplashMock.getListRows(rootSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-f',
      'media:media-e',
      `list:${overflowSubsplashListId}`,
    ]);
    expect(subsplashMock.getListRows(overflowSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-d',
      'media:media-c',
      `list:${tailSubsplashListId}`,
    ]);
    expect(subsplashMock.getListRows(tailSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-b',
      'media:media-a',
    ]);
  });

  it('preserves the actual remote split when firestore page counts drift from the physical chain', async () => {
    const rootSubsplashListId = 'subsplash-root-drifted-counts';
    const overflowSubsplashListId = 'subsplash-overflow-drifted-counts';
    const tailSubsplashListId = 'subsplash-tail-drifted-counts';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 200);
    subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 200);
    subsplashMock.createList(tailSubsplashListId, 'More Root List sermons', 0, 200);

    subsplashMock.listRows.set(rootSubsplashListId, [
      createMediaRow(rootSubsplashListId, 'row-a', 'media-a', 1),
      createMediaRow(rootSubsplashListId, 'row-b', 'media-b', 2),
      createOverflowRow(rootSubsplashListId, 'row-link-1', overflowSubsplashListId, 3),
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-c', 'media-c', 1),
      createMediaRow(overflowSubsplashListId, 'row-d', 'media-d', 2),
      createOverflowRow(overflowSubsplashListId, 'row-link-2', tailSubsplashListId, 3),
    ]);
    subsplashMock.listRows.set(tailSubsplashListId, [
      createMediaRow(tailSubsplashListId, 'row-e', 'media-e', 1),
      createMediaRow(tailSubsplashListId, 'row-f', 'media-f', 2),
    ]);

    const rootFirestoreListId = await createListDocument({
      id: 'root-drifted-counts',
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      logicalCount: 6,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-drifted-counts',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'overflow-drifted-counts',
      subsplashId: overflowSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-drifted-counts',
      overflowDepth: 1,
      moreSermonsRef: tailSubsplashListId,
    });
    await createListDocument({
      id: 'tail-drifted-counts',
      subsplashId: tailSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-drifted-counts',
      overflowDepth: 2,
    });
    await seedPublishedProjection({
      rootFirestoreListId,
      assignments: [
        {
          firestoreListId: 'root-drifted-counts',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-a', 'media-b'],
        },
        {
          firestoreListId: 'overflow-drifted-counts',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-c', 'media-d'],
        },
        {
          firestoreListId: 'tail-drifted-counts',
          subsplashListId: tailSubsplashListId,
          overflowDepth: 2,
          mediaIds: ['media-e', 'media-f'],
        },
      ],
    });

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: [
          { mediaItemId: 'media-f', position: 1 },
          { mediaItemId: 'media-e', position: 2 },
          { mediaItemId: 'media-d', position: 3 },
          { mediaItemId: 'media-c', position: 4 },
          { mediaItemId: 'media-b', position: 5 },
          { mediaItemId: 'media-a', position: 6 },
        ],
      },
    });

    expect(result.assignments).toEqual([
      expect.objectContaining({ mediaItemId: 'media-f', firestoreListId: 'root-drifted-counts', overflowDepth: 0, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-e', firestoreListId: 'root-drifted-counts', overflowDepth: 0, position: 2 }),
      expect.objectContaining({ mediaItemId: 'media-d', firestoreListId: 'overflow-drifted-counts', overflowDepth: 1, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-c', firestoreListId: 'overflow-drifted-counts', overflowDepth: 1, position: 2 }),
      expect.objectContaining({ mediaItemId: 'media-b', firestoreListId: 'tail-drifted-counts', overflowDepth: 2, position: 1 }),
      expect.objectContaining({ mediaItemId: 'media-a', firestoreListId: 'tail-drifted-counts', overflowDepth: 2, position: 2 }),
    ]);
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

  it('supports in-page reorder across all three physical pages without disturbing other pages or overflow rows', async () => {
    const baseOrder = Array.from({ length: 13 }, (_, index) => `media-${index + 1}`);
    const scenarios = [
      ['media-2', 'media-1', ...baseOrder.slice(2)],
      [...baseOrder.slice(0, 4), 'media-6', 'media-5', 'media-7', 'media-8', ...baseOrder.slice(8)],
      [...baseOrder.slice(0, 8), 'media-10', 'media-9', 'media-11', 'media-12', 'media-13'],
    ];

    for (const targetOrder of scenarios) {
      await clearFirestore();
      subsplashMock.reset();
      const fixture = await seedThirteenOverflowFixture();
      await seedPublishedProjection({
        rootFirestoreListId: fixture.rootFirestoreListId,
        assignments: [
          {
            firestoreListId: fixture.rootFirestoreListId,
            subsplashListId: fixture.rootSubsplashListId,
            overflowDepth: 0,
            mediaIds: ['media-1', 'media-2', 'media-3', 'media-4'],
          },
          {
            firestoreListId: 'thirteen-overflow-firestore',
            subsplashListId: fixture.overflowSubsplashListId,
            overflowDepth: 1,
            mediaIds: ['media-5', 'media-6', 'media-7', 'media-8'],
          },
          {
            firestoreListId: 'thirteen-tail-firestore',
            subsplashListId: fixture.tailSubsplashListId,
            overflowDepth: 2,
            mediaIds: ['media-9', 'media-10', 'media-11', 'media-12', 'media-13'],
          },
        ],
      });
      subsplashMock.clearHistory();
      const result = await reorderListItemsHandler({
        auth: { token: { role: 'admin' } },
        data: {
          rootListId: fixture.rootFirestoreListId,
          logicalItemOrder: targetOrder.map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
        },
      });

      expect(result.status).toBe('success');
      expect(subsplashMock.getListRows(fixture.rootSubsplashListId).map(getRowIdentity)).toEqual([
        `media:${targetOrder[0]}`,
        `media:${targetOrder[1]}`,
        `media:${targetOrder[2]}`,
        `media:${targetOrder[3]}`,
        `list:${fixture.overflowSubsplashListId}`,
      ]);
      expect(subsplashMock.getListRows(fixture.overflowSubsplashListId).map(getRowIdentity)).toEqual([
        `media:${targetOrder[4]}`,
        `media:${targetOrder[5]}`,
        `media:${targetOrder[6]}`,
        `media:${targetOrder[7]}`,
        `list:${fixture.tailSubsplashListId}`,
      ]);
      expect(subsplashMock.getListRows(fixture.tailSubsplashListId).map(getRowIdentity)).toEqual([
        `media:${targetOrder[8]}`,
        `media:${targetOrder[9]}`,
        `media:${targetOrder[10]}`,
        `media:${targetOrder[11]}`,
        `media:${targetOrder[12]}`,
      ]);
      assertSubsplashHistoryNeverExceedsCapacity(5);
    }
  });

  it('supports cross-boundary reorder without ever exceeding the physical page limits', async () => {
    const fixture = await seedThirteenOverflowFixture();
    await seedPublishedProjection({
      rootFirestoreListId: fixture.rootFirestoreListId,
      assignments: [
        {
          firestoreListId: fixture.rootFirestoreListId,
          subsplashListId: fixture.rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-1', 'media-2', 'media-3', 'media-4'],
        },
        {
          firestoreListId: 'thirteen-overflow-firestore',
          subsplashListId: fixture.overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-5', 'media-6', 'media-7', 'media-8'],
        },
        {
          firestoreListId: 'thirteen-tail-firestore',
          subsplashListId: fixture.tailSubsplashListId,
          overflowDepth: 2,
          mediaIds: ['media-9', 'media-10', 'media-11', 'media-12', 'media-13'],
        },
      ],
    });
    const targetOrder = [
      'media-13',
      'media-2',
      'media-3',
      'media-4',
      'media-5',
      'media-6',
      'media-7',
      'media-8',
      'media-9',
      'media-10',
      'media-11',
      'media-12',
      'media-1',
    ];

    subsplashMock.clearHistory();

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: fixture.rootFirestoreListId,
        logicalItemOrder: targetOrder.map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
      },
    });

    expect(result.status).toBe('success');
    expect(subsplashMock.getListRows(fixture.rootSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-13',
      'media:media-2',
      'media:media-3',
      'media:media-4',
      `list:${fixture.overflowSubsplashListId}`,
    ]);
    expect(subsplashMock.getListRows(fixture.overflowSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-5',
      'media:media-6',
      'media:media-7',
      'media:media-8',
      `list:${fixture.tailSubsplashListId}`,
    ]);
    expect(subsplashMock.getListRows(fixture.tailSubsplashListId).map(getRowIdentity)).toEqual([
      'media:media-9',
      'media:media-10',
      'media:media-11',
      'media:media-12',
      'media:media-1',
    ]);
    assertSubsplashHistoryNeverExceedsCapacity(5);
  });

  it('keeps one safety slot free when a full physical page receives a recreated row from overflow', async () => {
    const rootSubsplashListId = 'subsplash-root-capacity-safety';
    const overflowSubsplashListId = 'subsplash-overflow-capacity-safety';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 200);
    subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 200);

    const rootRows: SubsplashListRow[] = [];
    for (let index = 1; index <= 199; index += 1) {
      rootRows.push(createMediaRow(rootSubsplashListId, `row-${index}`, `media-${index}`, index));
    }
    rootRows.push(createOverflowRow(rootSubsplashListId, 'row-link-root', overflowSubsplashListId, 200));
    subsplashMock.listRows.set(rootSubsplashListId, rootRows);

    subsplashMock.listRows.set(overflowSubsplashListId, [
      createMediaRow(overflowSubsplashListId, 'row-200', 'media-200', 1),
      createMediaRow(overflowSubsplashListId, 'row-201', 'media-201', 2),
      createMediaRow(overflowSubsplashListId, 'row-202', 'media-202', 3),
    ]);

    subsplashMock.failPatchWhenAtCapacityWithNewRows(rootSubsplashListId);

    const rootFirestoreListId = await createListDocument({
      id: 'root-capacity-safety',
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 199,
      logicalCount: 202,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'root-capacity-safety',
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: 'overflow-capacity-safety',
      subsplashId: overflowSubsplashListId,
      title: 'More Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: 'root-capacity-safety',
      overflowDepth: 1,
    });

    await seedPublishedProjection({
      rootFirestoreListId,
      assignments: [
        {
          firestoreListId: 'root-capacity-safety',
          subsplashListId: rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: Array.from({ length: 199 }, (_, index) => `media-${index + 1}`),
        },
        {
          firestoreListId: 'overflow-capacity-safety',
          subsplashListId: overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-200', 'media-201', 'media-202'],
        },
      ],
    });

    const targetOrder = ['media-200', ...Array.from({ length: 199 }, (_, index) => `media-${index + 1}`), 'media-201', 'media-202'];

    const result = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: rootFirestoreListId,
        logicalItemOrder: targetOrder.map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
      },
    });

    expect(result.status).toBe('success');
    const rootFinalRows = subsplashMock.getListRows(rootSubsplashListId);
    const overflowFinalRows = subsplashMock.getListRows(overflowSubsplashListId);

    expect(rootFinalRows).toHaveLength(199);
    expect(rootFinalRows[rootFinalRows.length - 1]._embedded.list?.id).toBe(overflowSubsplashListId);
    expect(rootFinalRows.filter((row) => row.type !== 'list')).toHaveLength(198);
    expect(rootFinalRows[0]._embedded['media-item']?.id).toBe('media-200');

    expect(overflowFinalRows.map(getRowIdentity)).toEqual([
      'media:media-198',
      'media:media-199',
      'media:media-201',
      'media:media-202',
    ]);
  });

  it('replays duplicate reorder operation keys without repeating remote writes', async () => {
    const fixture = await seedThirteenOverflowFixture();
    await seedPublishedProjection({
      rootFirestoreListId: fixture.rootFirestoreListId,
      assignments: [
        {
          firestoreListId: fixture.rootFirestoreListId,
          subsplashListId: fixture.rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-1', 'media-2', 'media-3', 'media-4'],
        },
        {
          firestoreListId: 'thirteen-overflow-firestore',
          subsplashListId: fixture.overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-5', 'media-6', 'media-7', 'media-8'],
        },
        {
          firestoreListId: 'thirteen-tail-firestore',
          subsplashListId: fixture.tailSubsplashListId,
          overflowDepth: 2,
          mediaIds: ['media-9', 'media-10', 'media-11', 'media-12', 'media-13'],
        },
      ],
    });

    const targetOrder = [
      'media-13',
      'media-12',
      'media-11',
      'media-10',
      'media-9',
      'media-8',
      'media-7',
      'media-6',
      'media-5',
      'media-4',
      'media-3',
      'media-2',
      'media-1',
    ];

    subsplashMock.clearHistory();

    const firstResult = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: fixture.rootFirestoreListId,
        logicalItemOrder: targetOrder.map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
        operationKey: 'reorder-op-key-replay-1',
      },
    });
    const historyCountAfterFirst = subsplashMock.getHistory().length;

    const secondResult = await reorderListItemsHandler({
      auth: { token: { role: 'admin' } },
      data: {
        rootListId: fixture.rootFirestoreListId,
        logicalItemOrder: targetOrder.map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
        operationKey: 'reorder-op-key-replay-1',
      },
    });

    expect(firstResult).toEqual(secondResult);
    expect(subsplashMock.getHistory()).toHaveLength(historyCountAfterFirst);
  });

  it('surfaces published drift after a later-page reorder patch fails mid-flight', async () => {
    const fixture = await seedThirteenOverflowFixture();
    await seedPublishedProjection({
      rootFirestoreListId: fixture.rootFirestoreListId,
      assignments: [
        {
          firestoreListId: fixture.rootFirestoreListId,
          subsplashListId: fixture.rootSubsplashListId,
          overflowDepth: 0,
          mediaIds: ['media-1', 'media-2', 'media-3', 'media-4'],
        },
        {
          firestoreListId: 'thirteen-overflow-firestore',
          subsplashListId: fixture.overflowSubsplashListId,
          overflowDepth: 1,
          mediaIds: ['media-5', 'media-6', 'media-7', 'media-8'],
        },
        {
          firestoreListId: 'thirteen-tail-firestore',
          subsplashListId: fixture.tailSubsplashListId,
          overflowDepth: 2,
          mediaIds: ['media-9', 'media-10', 'media-11', 'media-12', 'media-13'],
        },
      ],
    });

    networkFailureInjector.registerFailure(
      `patchList:${fixture.tailSubsplashListId}`,
      (() => {
        let failed = false;
        return () => {
          if (failed) {
            return false;
          }
          failed = true;
          return true;
        };
      })()
    );

    await expect(
      reorderListItemsHandler({
        auth: { token: { role: 'admin' } },
        data: {
          rootListId: fixture.rootFirestoreListId,
          logicalItemOrder: [
            'media-13',
            'media-12',
            'media-11',
            'media-10',
            'media-9',
            'media-8',
            'media-7',
            'media-6',
            'media-5',
            'media-4',
            'media-3',
            'media-2',
            'media-1',
          ].map((mediaItemId, index) => ({ mediaItemId, position: index + 1 })),
        },
      })
    ).rejects.toBeTruthy();

    assertSubsplashHistoryNeverExceedsCapacity(5);

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');
    expect(drift.inSync).toBe(false);
    expect(drift.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MEMBERSHIP_MISMATCH',
        }),
      ])
    );
  });
});
