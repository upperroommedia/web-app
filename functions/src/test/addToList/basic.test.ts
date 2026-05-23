import { OverflowBehavior } from '@upperroom/shared/types/List';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { SubsplashListRow, SubsplashPatchPayload } from '../../types/Subsplash';
import { 
  subsplashMock,
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore, createSermonDocument, getListBySubsplashId } from './firestoreHelpers';
import addToList from '../../addToList';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';

jest.mock('../../helpers/publishedListDrift', () => {
  const actual = jest.requireActual('../../helpers/publishedListDrift');
  return {
    ...actual,
    ensureCanPerformStrictPublishedMutation: jest.fn().mockResolvedValue(undefined),
  };
});

const addToListHandler = addToList as unknown as AddToListHandler;
const firestoreDB = firebaseAdmin.firestore();

const buildSermon = (id: string, subsplashId: string) => ({
  id,
  title: id,
  description: '',
  speakers: [],
  subtitle: '',
  dateMillis: 1,
  sourceStartTime: 0,
  durationSeconds: 60,
  topics: [],
  status: {
    subsplash: uploadStatus.UPLOADED,
    soundCloud: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PROCESSED,
  },
  images: [],
  createdAtMillis: 1,
  editedAtMillis: 1,
  subsplashId,
});

describe('addToList - Basic Functionality (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });

  it('should add item to empty list', async () => {
    const listId = 'basic-test-list-1';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    const firestoreListId = await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    await createSermonDocument(buildSermon('sermon-1', 'media-1'));
    const mediaItem = { id: 'media-1', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      
      // Verify the listItemId matches the actual row ID
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(1);
      expect(rows[0]._embedded['media-item']?.id).toBe('media-1');
      expect(rows[0].id).toBe(result[0].listItemId);
    }

    const mirroredListItem = await firestoreDB
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .get();
    expect(mirroredListItem.exists).toBe(true);
    expect(mirroredListItem.data()).toMatchObject({
      subsplashId: 'media-1',
      position: 1,
      uploadStatus: {
        status: uploadStatus.UPLOADED,
        listItemId: result[0].status === 'success' ? result[0].listItemId : undefined,
      },
    });
  });

  it('should handle overflow by creating new list and linking', async () => {
    const listId = 'basic-full-list';
    subsplashMock.createList(listId, 'Full List', 10);
    const initialRows = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: { 
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` } 
      }
    }));
    subsplashMock.listRows.set(listId, initialRows);

    // Create Firestore document for the list
    const rootFirestoreId = await createListDocument({
      subsplashId: listId,
      title: 'Full List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });
    await createSermonDocument(buildSermon('sermon-new', 'new-item'));
    for (let i = 0; i < 10; i += 1) {
      await createSermonDocument(buildSermon(`sermon-${i}`, `item-${i}`));
    }

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    
    const updatedOriginalRows = subsplashMock.getListRows(listId);
    expect(updatedOriginalRows).toHaveLength(10);
    expect(updatedOriginalRows[0]._embedded['media-item']?.id).toBe('new-item');
    
    if (result[0].status === 'success') {
      // Verify listItemId is returned for the newly added item
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      // Verify the listItemId matches the row at position 1
      expect(updatedOriginalRows[0].id).toBe(result[0].listItemId);
    }
    
    const lastRow = updatedOriginalRows[9];
    expect(lastRow.type).toBe('list');
    
    const newListId = lastRow._embedded['list']?.id;
    expect(newListId).toBeDefined();
    
    const newListRows = subsplashMock.getListRows(newListId!);
    expect(newListRows).toHaveLength(2);
    expect(newListRows[0]._embedded['media-item']?.id).toBe('item-8');
    expect(newListRows[1]._embedded['media-item']?.id).toBe('item-9');

    const updatedRootDoc = await getListBySubsplashId(listId);
    const overflowDoc = await getListBySubsplashId(newListId!);
    expect(updatedRootDoc).not.toBeNull();
    expect(overflowDoc).not.toBeNull();
    expect(updatedRootDoc!.data()).toMatchObject({
      count: 9,
      logicalCount: 11,
      hasOverflowPages: true,
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
      moreSermonsRef: newListId,
    });
    expect(overflowDoc!.data()).toMatchObject({
      count: 2,
      name: 'More Full List sermons',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
    expect(subsplashMock.getList(newListId!)?.title).toBe('More Full List sermons');
    expect(subsplashMock.getList(newListId!)?.subtitle).toBe('Page 1');

    const rootMirrorSnapshot = await firestoreDB.collection('lists').doc(rootFirestoreId).collection('listItems').get();
    expect(rootMirrorSnapshot.size).toBe(11);
    expect(rootMirrorSnapshot.docs.map((doc) => doc.get('subsplashId'))).toContain('new-item');

    const overflowMirrorDoc = await getListBySubsplashId(newListId!);
    const overflowMirrorSnapshot = await firestoreDB
      .collection('lists')
      .doc(overflowMirrorDoc!.id)
      .collection('listItems')
      .get();
    expect(overflowMirrorSnapshot.size).toBe(0);
  });

  it('keeps a safety slot free when uploading into a full 200-row physical page with overflow', async () => {
    const rootListId = 'physical-cap-root';
    const overflowListId = 'physical-cap-overflow';
    subsplashMock.createList(rootListId, 'Repentance', 0, 200);
    subsplashMock.createList(overflowListId, 'More Repentance sermons', 0, 200);
    subsplashMock.failPatchWhenAtCapacityWithNewRows(rootListId);

    const rootRows: SubsplashListRow[] = [
      ...Array.from({ length: 198 }, (_, index) => ({
        id: `root-row-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static' as const,
        position: index + 1,
        type: 'media-item' as const,
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: `root-item-${index + 1}` },
        },
      })),
      {
        id: 'root-link-row',
        app_key: '9XTSHD',
        method: 'static' as const,
        position: 199,
        type: 'list' as const,
        _embedded: {
          'source-list': { id: rootListId },
          list: { id: overflowListId },
        },
      },
    ];
    const overflowRows: SubsplashListRow[] = Array.from({ length: 3 }, (_, index) => ({
      id: `overflow-row-${index + 1}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: index + 1,
      type: 'media-item' as const,
      _embedded: {
        'source-list': { id: overflowListId },
        'media-item': { id: `overflow-item-${index + 1}` },
      },
    }));
    subsplashMock.listRows.set(rootListId, rootRows);
    subsplashMock.listRows.set(overflowListId, overflowRows);

    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Repentance',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 198,
      maxListSize: 200,
      moreSermonsRef: overflowListId,
    });
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Repentance sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      maxListSize: 200,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
    await createSermonDocument(buildSermon('sermon-new', 'new-item'));

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'new-item', type: 'media-item' as const },
        maxListSize: 200,
      },
    };

    const result = await addToListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');

    const updatedRootRows = subsplashMock.getListRows(rootListId);
    expect(updatedRootRows).toHaveLength(199);
    expect(updatedRootRows[0]._embedded['media-item']?.id).toBe('new-item');
    expect(updatedRootRows[198].type).toBe('list');
    expect(updatedRootRows[198]._embedded.list?.id).toBe(overflowListId);

    const updatedRootMediaIds = updatedRootRows
      .filter((row) => row.type === 'media-item')
      .map((row) => row._embedded['media-item']?.id);
    expect(updatedRootMediaIds).toHaveLength(198);
    expect(updatedRootMediaIds).not.toContain('root-item-198');

    const updatedOverflowRows = subsplashMock.getListRows(overflowListId);
    expect(updatedOverflowRows).toHaveLength(4);
    expect(updatedOverflowRows[0]._embedded['media-item']?.id).toBe('root-item-198');
    expect(updatedOverflowRows.slice(1).map((row) => row._embedded['media-item']?.id)).toEqual([
      'overflow-item-1',
      'overflow-item-2',
      'overflow-item-3',
    ]);
  });

  it('repairs hidden full-capacity metadata by patching only the visible root capacity', async () => {
    const rootListId = 'phantom-cap-root';
    const overflowListId = 'phantom-cap-overflow';
    subsplashMock.createList(rootListId, 'Palm Sunday Sermons', 200, 200);
    subsplashMock.createList(overflowListId, 'More Palm Sunday Sermons', 0, 200);
    subsplashMock.failPatchWhenHiddenCapacityIsFull(rootListId);

    const rootRows: SubsplashListRow[] = [
      ...Array.from({ length: 197 }, (_, index) => ({
        id: `root-row-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static' as const,
        position: index + 1,
        type: 'media-item' as const,
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: `root-item-${index + 1}` },
        },
      })),
      {
        id: 'root-link-row',
        app_key: '9XTSHD',
        method: 'static' as const,
        position: 198,
        type: 'list' as const,
        _embedded: {
          'source-list': { id: rootListId },
          list: { id: overflowListId },
        },
      },
    ];
    const overflowRows: SubsplashListRow[] = Array.from({ length: 3 }, (_, index) => ({
      id: `overflow-row-${index + 1}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: index + 1,
      type: 'media-item' as const,
      _embedded: {
        'source-list': { id: overflowListId },
        'media-item': { id: `overflow-item-${index + 1}` },
      },
    }));
    subsplashMock.listRows.set(rootListId, rootRows);
    subsplashMock.listRows.set(overflowListId, overflowRows);

    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Palm Sunday Sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 197,
      logicalCount: 212,
      maxListSize: 200,
      moreSermonsRef: overflowListId,
    });
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Palm Sunday Sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      maxListSize: 200,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
    await createSermonDocument(buildSermon('sermon-phantom', 'new-phantom-item'));

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'new-phantom-item', type: 'media-item' as const },
        maxListSize: 200,
      },
    };

    const result = await addToListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');

    const updatedRootRows = subsplashMock.getListRows(rootListId);
    expect(updatedRootRows).toHaveLength(198);
    expect(subsplashMock.getList(rootListId)?.list_rows_count).toBe(198);
    expect(updatedRootRows[0]._embedded['media-item']?.id).toBe('new-phantom-item');
    expect(updatedRootRows[197].type).toBe('list');
    expect(updatedRootRows[197]._embedded.list?.id).toBe(overflowListId);

    const updatedRootMediaIds = updatedRootRows
      .filter((row) => row.type === 'media-item')
      .map((row) => row._embedded['media-item']?.id);
    expect(updatedRootMediaIds).toHaveLength(197);
    expect(updatedRootMediaIds).not.toContain('root-item-197');

    const updatedOverflowRows = subsplashMock.getListRows(overflowListId);
    expect(updatedOverflowRows).toHaveLength(4);
    expect(updatedOverflowRows[0]._embedded['media-item']?.id).toBe('root-item-197');
  });

  it('adopts an existing nested list as the overflow list when its title matches the root list', async () => {
    const rootListId = 'root-adopt-overflow';
    const existingOverflowListId = 'existing-overflow-list';

    subsplashMock.createList(rootListId, 'Fr. Anthony Messeh', 5);
    subsplashMock.createList(existingOverflowListId, 'More Fr Anthony sermons archive', 0);
    subsplashMock.listRows.set(rootListId, [
      {
        id: 'row-0',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-0' },
        },
      },
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-1' },
        },
      },
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-2' },
        },
      },
      {
        id: 'row-3',
        app_key: '9XTSHD',
        method: 'static',
        position: 4,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-3' },
        },
      },
      {
        id: 'row-list',
        app_key: '9XTSHD',
        method: 'static',
        position: 5,
        type: 'list',
        _embedded: {
          'source-list': { id: rootListId },
          'list': { id: existingOverflowListId, title: 'More Fr Anthony sermons archive' },
        },
      },
    ]);

    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Fr. Anthony Messeh',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 5,
    });
    await createSermonDocument(buildSermon('sermon-new-overflow', 'new-overflow-item'));

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'new-overflow-item', type: 'media-item' },
        maxListSize: 5,
      },
    };

    await addToListHandler(request);

    const rootRows = subsplashMock.getListRows(rootListId);
    const adoptedLinkRow = rootRows[rootRows.length - 1];
    expect(adoptedLinkRow.type).toBe('list');
    expect(adoptedLinkRow._embedded.list?.id).toBe(existingOverflowListId);

    const overflowRows = subsplashMock.getListRows(existingOverflowListId);
    expect(overflowRows.map((row) => row._embedded['media-item']?.id)).toContain('item-3');

    const createListEvents = subsplashMock.getHistory().filter((entry) => entry.event === 'create-list');
    expect(createListEvents).toHaveLength(0);

    const rootDoc = await getListBySubsplashId(rootListId);
    const adoptedOverflowDoc = await getListBySubsplashId(existingOverflowListId);
    expect(rootDoc!.data()).toMatchObject({
      moreSermonsRef: existingOverflowListId,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
    });
    expect(adoptedOverflowDoc!.data()).toMatchObject({
      subsplashId: existingOverflowListId,
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
  });

  it('should fail without making changes when the existing Subsplash list already exceeds maxListSize', async () => {
    const listId = 'basic-too-large-for-configured-max';
    subsplashMock.createList(listId, 'Too Large List', 10);
    const initialRows = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: {
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` }
      }
    }));
    subsplashMock.listRows.set(listId, initialRows);

    const firestoreListId = await createListDocument({
      subsplashId: listId,
      title: 'Too Large List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    const beforeUpdatedAt = (await firestoreDB.collection('lists').doc(firestoreListId).get()).get('updatedAtMillis');

    await createSermonDocument(buildSermon('sermon-too-large', 'media-too-large'));
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem: { id: 'media-too-large', type: 'media-item' as const },
        maxListSize: 3
      }
    };

    const result = await addToListHandler(request);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: 'error',
      errorCode: 'failed-precondition',
      error: expect.stringContaining('exceeds the configured maxListSize of 3'),
    });

    const afterRows = subsplashMock.getListRows(listId);
    expect(afterRows).toHaveLength(10);
    expect(afterRows.map((row) => row._embedded['media-item']?.id)).toEqual(
      initialRows.map((row) => row._embedded['media-item']?.id)
    );

    const afterDoc = await firestoreDB.collection('lists').doc(firestoreListId).get();
    expect(afterDoc.get('updatedAtMillis')).toBe(beforeUpdatedAt);

    const mirroredListItem = await firestoreDB
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-too-large')
      .get();
    expect(mirroredListItem.exists).toBe(false);
  });

  it('does not hijack an existing standalone Firestore list when a matching nested list already exists', async () => {
    const rootListId = 'root-existing-standalone';
    const nestedExistingListId = 'nested-existing-standalone';

    subsplashMock.createList(rootListId, 'Repentance', 5);
    subsplashMock.createList(nestedExistingListId, 'More Repentance sermons archive', 0);
    subsplashMock.listRows.set(rootListId, [
      {
        id: 'row-0',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-0' },
        },
      },
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-1' },
        },
      },
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-2' },
        },
      },
      {
        id: 'row-3',
        app_key: '9XTSHD',
        method: 'static',
        position: 4,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'item-3' },
        },
      },
      {
        id: 'row-list',
        app_key: '9XTSHD',
        method: 'static',
        position: 5,
        type: 'list',
        _embedded: {
          'source-list': { id: rootListId },
          list: { id: nestedExistingListId, title: 'More Repentance sermons archive' },
        },
      },
    ]);

    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Repentance',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 5,
    });

    const standaloneExistingFirestoreId = await createListDocument({
      subsplashId: nestedExistingListId,
      title: 'Repentance Archive',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      isRootList: true,
      rootListId: 'standalone-root-list',
      overflowDepth: 0,
    });

    await createSermonDocument(buildSermon('sermon-new-overflow-standalone', 'new-overflow-item-standalone'));

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: { id: 'new-overflow-item-standalone', type: 'media-item' },
        maxListSize: 5,
      },
    };

    await addToListHandler(request);

    const rootDoc = await getListBySubsplashId(rootListId);
    expect(rootDoc).not.toBeNull();

    const linkedOverflowSubsplashId = rootDoc!.data().moreSermonsRef;
    expect(linkedOverflowSubsplashId).toBeDefined();
    expect(linkedOverflowSubsplashId).not.toBe(nestedExistingListId);

    const originalStandaloneDoc = await firestoreDB.collection('lists').doc(standaloneExistingFirestoreId).get();
    expect(originalStandaloneDoc.data()).toMatchObject({
      subsplashId: nestedExistingListId,
      isRootList: true,
      rootListId: 'standalone-root-list',
      overflowDepth: 0,
    });

    const newOverflowDoc = await getListBySubsplashId(linkedOverflowSubsplashId!);
    expect(newOverflowDoc).not.toBeNull();
    expect(newOverflowDoc!.id).not.toBe(standaloneExistingFirestoreId);
    expect(newOverflowDoc!.data()).toMatchObject({
      subsplashId: linkedOverflowSubsplashId,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
  });

  it('should propagate overflow down multiple lists in chain', async () => {
    const listA = 'basic-list-a';
    const listB = 'basic-list-b';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    
    const rowsA: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `a-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listA }, 'media-item': { id: `a-item-${i}` } }
    }));
    rowsA.push({
      id: 'a-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listA }, 'list': { id: listB } }
    });
    subsplashMock.listRows.set(listA, rowsA);
    
    const rowsB: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `b-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listB }, 'media-item': { id: `b-item-${i}` } }
    }));
    subsplashMock.listRows.set(listB, rowsB);
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item-a', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const updatedA = subsplashMock.getListRows(listA);
    expect(updatedA).toHaveLength(10);
    expect(updatedA[0]._embedded['media-item']?.id).toBe('new-item-a');
    expect(updatedA[9].type).toBe('list');
    expect(updatedA[9]._embedded.list?.id).toBe(listB);
    
    const updatedB = subsplashMock.getListRows(listB);
    expect(updatedB).toHaveLength(10);
    expect(updatedB[0]._embedded['media-item']?.id).toBe('a-item-8');
    expect(updatedB[9].type).toBe('list');
    
    const listCId = updatedB[9]._embedded.list?.id;
    expect(listCId).toBeDefined();
    
    const updatedC = subsplashMock.getListRows(listCId!);
    expect(updatedC).toHaveLength(2);
    expect(updatedC[0]._embedded['media-item']?.id).toBe('b-item-8');
    expect(updatedC[1]._embedded['media-item']?.id).toBe('b-item-9');
  });

  it('should handle overflow when both main and overflow lists are at 10', async () => {
    const listA = 'basic-list-a-2';
    const listB = 'basic-list-b-2';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    
    const rowsA: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `a-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listA }, 'media-item': { id: `a-item-${i}` } }
    }));
    rowsA.push({
      id: 'a-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listA }, 'list': { id: listB } }
    });
    subsplashMock.listRows.set(listA, rowsA);
    
    const rowsB: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `b-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listB }, 'media-item': { id: `b-item-${i}` } }
    }));
    rowsB.push({
      id: 'b-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listB }, 'list': { id: 'list-c-placeholder' } }
    });
    subsplashMock.listRows.set(listB, rowsB);
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const updatedA = subsplashMock.getListRows(listA);
    expect(updatedA).toHaveLength(10);
    expect(updatedA[0]._embedded['media-item']?.id).toBe('new-item');
    expect(updatedA[9].type).toBe('list');
    
    const updatedB = subsplashMock.getListRows(listB);
    expect(updatedB).toHaveLength(10);
    expect(updatedB[0]._embedded['media-item']?.id).toBe('a-item-8');
    expect(updatedB[9].type).toBe('list');
    
    const listCId = updatedB[9]._embedded.list?.id;
    expect(listCId).toBeDefined();
    expect(listCId).not.toBe('list-c-placeholder');
    
    const updatedC = subsplashMock.getListRows(listCId!);
    expect(updatedC.length).toBeLessThanOrEqual(10);
    expect(updatedC[0]._embedded['media-item']?.id).toBe('b-item-8');
  });

  it('should never attempt to patch with more than 10 items', async () => {
    const listId = 'basic-max-size-list';
    subsplashMock.createList(listId, 'Max Size Test List', 10);
    
    // Create exactly 10 items (all content, no link)
    const rows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listId }, 'media-item': { id: `item-${i}` } }
    }));
    subsplashMock.listRows.set(listId, rows);
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Max Size Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });
    
    // Spy on patchList to verify it's never called with >10 items
    const patchListSpy = jest.spyOn(subsplashMock, 'patchList');
    
    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };
    
    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    // Verify patchList was never called with more than 10 items
    const patchCalls = patchListSpy.mock.calls;
    expect(patchCalls.length).toBeGreaterThan(0);
    
    for (const call of patchCalls) {
      const payload = call[1] as SubsplashPatchPayload;
      const rowCount = payload._embedded['list-rows'].length;
      expect(rowCount).toBeLessThanOrEqual(10);
      expect(rowCount).toBeGreaterThan(0);
      expect(payload.list_rows_count).toBe(rowCount);
    }
    
    // Verify final state: list should have exactly 10 items (9 content + 1 link)
    const finalRows = subsplashMock.getListRows(listId);
    expect(finalRows).toHaveLength(10);
    expect(finalRows[0]._embedded['media-item']?.id).toBe('new-item');
    expect(finalRows[9].type).toBe('list'); // Last item should be link
    
    patchListSpy.mockRestore();
  });

  it('should never exceed 10 items in any list during propagation', async () => {
    const listA = 'basic-list-a-3';
    const listB = 'basic-list-b-3';
    const listC = 'basic-list-c-3';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    subsplashMock.createList(listC, 'List C', 10);
    
    const setupList = (id: string, prefix: string, nextId?: string) => {
      const rows: SubsplashListRow[] = Array.from({ length: nextId ? 9 : 10 }, (_, i) => ({
        id: `${prefix}-row-${i}`,
        app_key: '9XTSHD',
        method: 'static',
        position: i + 1,
        type: 'media-item',
        _embedded: { 'source-list': { id }, 'media-item': { id: `${prefix}-item-${i}` } }
      }));
      if (nextId) {
        rows.push({
          id: `${prefix}-link`,
          app_key: '9XTSHD',
          method: 'static',
          position: 10,
          type: 'list',
          _embedded: { 'source-list': { id }, 'list': { id: nextId } }
        });
      }
      subsplashMock.listRows.set(id, rows);
    };
    
    setupList(listA, 'a', listB);
    setupList(listB, 'b', listC);
    setupList(listC, 'c');
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listC,
    });
    await createListDocument({
      subsplashId: listC,
      title: 'List C',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const finalA = subsplashMock.getListRows(listA);
    const finalB = subsplashMock.getListRows(listB);
    const finalC = subsplashMock.getListRows(listC);
    
    expect(finalA.length).toBeLessThanOrEqual(10);
    expect(finalB.length).toBeLessThanOrEqual(10);
    expect(finalC.length).toBeLessThanOrEqual(10);
    
    expect(finalA[0]._embedded['media-item']?.id).toBe('new-item');
    
    expect(finalB.length).toBeGreaterThan(0);
    expect(finalC.length).toBeGreaterThan(0);
  });

  it('should always place new items at top and overflow list links at bottom', async () => {
    const listId = 'basic-ordering-test';
    subsplashMock.createList(listId, 'Ordering Test List', 0);
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Ordering Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
    });

    // Add first item
    const item1 = { id: 'item-1', type: 'media-item' as const };
    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item1, maxListSize: 10 }
    };
    await addToListHandler(request1);
    
    let rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-1');
    expect(rows[0].position).toBe(1);
    
    // Add second item - should go to top
    const item2 = { id: 'item-2', type: 'media-item' as const };
    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item2, maxListSize: 10 }
    };
    await addToListHandler(request2);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(2);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-2'); // New item at top
    expect(rows[0].position).toBe(1);
    expect(rows[1]._embedded['media-item']?.id).toBe('item-1'); // Old item pushed down
    expect(rows[1].position).toBe(2);
    
    // Add third item - should go to top
    const item3 = { id: 'item-3', type: 'media-item' as const };
    const request3: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item3, maxListSize: 10 }
    };
    await addToListHandler(request3);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(3);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-3'); // Newest at top
    expect(rows[1]._embedded['media-item']?.id).toBe('item-2');
    expect(rows[2]._embedded['media-item']?.id).toBe('item-1'); // Oldest at bottom
    
    // Now fill the list to trigger overflow
    // We need 7 more items to reach 10 (3 + 7 = 10)
    for (let i = 4; i <= 10; i++) {
      const item = { id: `item-${i}`, type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: { destinationListIds: [listId], mediaItem: item, maxListSize: 10 }
      };
      await addToListHandler(request);
    }
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('item-10');
    // Verify second-to-last item is item-2
    expect(rows[8]._embedded['media-item']?.id).toBe('item-2');
    // Verify oldest item is at position 10 (no link yet - link only appears after overflow)
    expect(rows[9]._embedded['media-item']?.id).toBe('item-1');
    // No link at this point - we have exactly 10 items, no overflow yet
    
    // Add one more item to trigger overflow
    const overflowItem = { id: 'overflow-item', type: 'media-item' as const };
    const overflowRequest: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: overflowItem, maxListSize: 10 }
    };
    await addToListHandler(overflowRequest);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('overflow-item');
    // Verify link is still at bottom
    expect(rows[9].type).toBe('list');
    expect(rows[9].position).toBe(10);
    
    // Verify overflow list was created and has the overflowed items
    const overflowListId = rows[9]._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    expect(overflowRows.length).toBeGreaterThan(0);
    // Verify overflow list also has newest items at top
    // The overflowed items should be item-1 and item-2 (the oldest ones)
    const overflowItemIds = overflowRows
      .filter(r => r.type === 'media-item')
      .map(r => r._embedded['media-item']?.id);
    expect(overflowItemIds).toContain('item-1');
    expect(overflowItemIds).toContain('item-2');
    
    // Add another item to the original list
    const anotherItem = { id: 'another-item', type: 'media-item' as const };
    const anotherRequest: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: anotherItem, maxListSize: 10 }
    };
    await addToListHandler(anotherRequest);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('another-item');
    // Verify link is still at bottom
    expect(rows[9].type).toBe('list');
    expect(rows[9].position).toBe(10);
    
    // Verify no link rows appear in the middle of the list
    const allLinks = rows.filter(r => r.type === 'list');
    expect(allLinks).toHaveLength(1);
    expect(allLinks[0].position).toBe(10); // Only one link, at the bottom
  });

  describe('listItemId functionality', () => {
    it('should return listItemId for newly added item', async () => {
      const listId = 'listitemid-test-1';
      subsplashMock.createList(listId, 'Test List');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const mediaItem = { id: 'new-item-1', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
        expect(typeof result[0].listItemId).toBe('string');
        expect(result[0].listItemId!.length).toBeGreaterThan(0);
        
        // Verify the listItemId matches the actual row in Subsplash
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(result[0].listItemId);
        expect(rows[0]._embedded['media-item']?.id).toBe('new-item-1');
        expect(rows[0].position).toBe(1);
      }
    });

    it('should move an existing root item to the top without duplicating it', async () => {
      const listId = 'listitemid-test-2';
      subsplashMock.createList(listId, 'Test List');
      
      const firstRow: SubsplashListRow = {
        id: 'first-row-id',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'first-item' }
        }
      };
      const existingRow: SubsplashListRow = {
        id: 'existing-row-id-123',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'existing-item' }
        }
      };
      subsplashMock.listRows.set(listId, [firstRow, existingRow]);
      
      await createListDocument({
        subsplashId: listId,
        title: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 2,
      });
      
      // Try to add the same item again
      const mediaItem = { id: 'existing-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBe('existing-row-id-123');
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toBe('existing-row-id-123');
        expect(rows[0]._embedded['media-item']?.id).toBe('existing-item');
        expect(rows[1]._embedded['media-item']?.id).toBe('first-item');
        expect(rows.filter((row) => row._embedded['media-item']?.id === 'existing-item')).toHaveLength(1);
      }
    });

    it('should return different listItemIds for multiple lists', async () => {
      const listId1 = 'listitemid-test-3a';
      const listId2 = 'listitemid-test-3b';
      
      subsplashMock.createList(listId1, 'Test List 1');
      subsplashMock.createList(listId2, 'Test List 2');
      
      await createListDocument({
        subsplashId: listId1,
        title: 'Test List 1',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      await createListDocument({
        subsplashId: listId2,
        title: 'Test List 2',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const mediaItem = { id: 'shared-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId1, listId2],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('success');
      expect(result[1].status).toBe('success');
      
      if (result[0].status === 'success' && result[1].status === 'success') {
        // Each list should have its own listItemId
        expect(result[0].listItemId).toBeDefined();
        expect(result[1].listItemId).toBeDefined();
        expect(result[0].listItemId).not.toBe(result[1].listItemId);
        
        // Verify the listItemIds match the actual rows
        const rows1 = subsplashMock.getListRows(listId1);
        const rows2 = subsplashMock.getListRows(listId2);
        
        expect(rows1[0].id).toBe(result[0].listItemId);
        expect(rows2[0].id).toBe(result[1].listItemId);
      }
    });

    it('should not return listItemId on error', async () => {
      const listId = 'listitemid-test-4';
      // Don't create the list in Firestore - this should cause an error
      
      const mediaItem = { id: 'item-1', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('error');
      if (result[0].status === 'error') {
        expect(result[0].error).toBeDefined();
        // Error responses should not have listItemId (it's not in the type, but verify)
        expect('listItemId' in result[0]).toBe(false);
      }
    });

    it('should return listItemId for original list even when overflow occurs', async () => {
      const listId = 'listitemid-test-5';
      subsplashMock.createList(listId, 'Full List', 10);
      
      const initialRows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
        id: `row-${i}`,
        app_key: '9XTSHD',
        method: 'static' as const,
        position: i + 1,
        type: 'media-item' as const,
        _embedded: { 
          'source-list': { id: listId },
          'media-item': { id: `item-${i}` } 
        }
      }));
      subsplashMock.listRows.set(listId, initialRows);
      
      await createListDocument({
        subsplashId: listId,
        title: 'Full List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 10,
      });
      
      const mediaItem = { id: 'overflow-trigger-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        // Should return listItemId for the item in the original list (position 1)
        expect(result[0].listItemId).toBeDefined();
        
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(10);
        // The new item should be at position 1
        expect(rows[0]._embedded['media-item']?.id).toBe('overflow-trigger-item');
        expect(rows[0].id).toBe(result[0].listItemId);
      }
    });

    it('should move an item from overflow to the root page without duplicating it', async () => {
      const listId = 'listitemid-test-6';
      const overflowListId = 'listitemid-test-6-overflow';
      
      subsplashMock.createList(listId, 'Main List', 10);
      subsplashMock.createList(overflowListId, 'Overflow List', 0);
      
      // Create main list with 9 items + 1 link
      const mainRows: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
        id: `main-row-${i}`,
        app_key: '9XTSHD',
        method: 'static' as const,
        position: i + 1,
        type: 'media-item' as const,
        _embedded: { 
          'source-list': { id: listId },
          'media-item': { id: `item-${i}` } 
        }
      }));
      mainRows.push({
        id: 'main-link',
        app_key: '9XTSHD',
        method: 'static' as const,
        position: 10,
        type: 'list' as const,
        _embedded: { 
          'source-list': { id: listId },
          'list': { id: overflowListId }
        }
      });
      subsplashMock.listRows.set(listId, mainRows);
      
      // Create overflow list with an existing item
      const overflowRow: SubsplashListRow = {
        id: 'overflow-row-existing',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: overflowListId },
          'media-item': { id: 'existing-in-overflow' }
        }
      };
      subsplashMock.listRows.set(overflowListId, [overflowRow]);
      
      await createListDocument({
        subsplashId: listId,
        title: 'Main List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        moreSermonsRef: overflowListId,
        count: 10,
      });
      await createListDocument({
        subsplashId: overflowListId,
        title: 'Overflow List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 1,
        isMoreSermonsList: true,
      });
      
      // Try to add item that already exists in overflow list
      const mediaItem = { id: 'existing-in-overflow', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
        const mainListRows = subsplashMock.getListRows(listId);
        expect(mainListRows[0]._embedded['media-item']?.id).toBe('existing-in-overflow');
        expect(mainListRows[0].id).toBe(result[0].listItemId);

        const overflowListRows = subsplashMock.getListRows(overflowListId);
        const allIds = [...mainListRows, ...overflowListRows]
          .map((row) => row._embedded['media-item']?.id)
          .filter((value): value is string => Boolean(value));
        expect(allIds.filter((id) => id === 'existing-in-overflow')).toHaveLength(1);
      }
    });

    it('should return listItemId for each list in parallel processing', async () => {
      const listIds = ['listitemid-test-7a', 'listitemid-test-7b', 'listitemid-test-7c'];
      
      listIds.forEach(id => {
        subsplashMock.createList(id, `Test List ${id}`);
      });
      
      await Promise.all(listIds.map(id => 
        createListDocument({
          subsplashId: id,
          title: `Test List ${id}`,
          overflowBehavior: OverflowBehavior.CREATENEWLIST,
        })
      ));
      
      const mediaItem = { id: 'parallel-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: listIds,
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(3);
      result.forEach((r, index) => {
        expect(r.status).toBe('success');
        if (r.status === 'success') {
          expect(r.listId).toBe(listIds[index]);
          expect(r.listItemId).toBeDefined();
          
          // Verify each listItemId is unique
          const otherResults = result.filter((other, otherIndex) => 
            otherIndex !== index && other.status === 'success'
          );
          otherResults.forEach(other => {
            if (other.status === 'success') {
              expect(r.listItemId).not.toBe(other.listItemId);
            }
          });
          
          // Verify the listItemId matches the actual row
          const rows = subsplashMock.getListRows(listIds[index]);
          expect(rows[0].id).toBe(r.listItemId);
        }
      });
    });

    it('should handle case where listItemId might be undefined gracefully', async () => {
      const listId = 'listitemid-test-edge';
      subsplashMock.createList(listId, 'Edge Case Test');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Edge Case Test',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      // Add an item normally
      const mediaItem = { id: 'normal-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      
      // In normal cases, listItemId should be defined
      // But the type allows it to be optional, so we verify the structure is correct
      if (result[0].status === 'success') {
        // listItemId should be defined in normal operation
        // If it's undefined, that's an edge case we want to know about
        expect(result[0].listItemId).toBeDefined();
      }
    });

    it('should return listItemId even when multiple items are added sequentially', async () => {
      const listId = 'listitemid-test-sequential';
      subsplashMock.createList(listId, 'Sequential Test');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Sequential Test',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const items = [
        { id: 'seq-item-1', type: 'media-item' as const },
        { id: 'seq-item-2', type: 'media-item' as const },
        { id: 'seq-item-3', type: 'media-item' as const },
      ];
      
      const results: Array<{ listItemId?: string }> = [];
      
      for (const item of items) {
        const request: TestRequest = {
          auth: { token: { role: 'admin' } },
          data: {
            destinationListIds: [listId],
            mediaItem: item
          }
        };
        
        const result = await addToListHandler(request);
        expect(result[0].status).toBe('success');
        if (result[0].status === 'success') {
          results.push({ listItemId: result[0].listItemId });
        }
      }
      
      // Each sequential add should return a listItemId
      expect(results).toHaveLength(3);
      
      // After all adds, the newest item should be at position 1
      const finalRows = subsplashMock.getListRows(listId);
      expect(finalRows[0]._embedded['media-item']?.id).toBe('seq-item-3'); // Last added
      
      // The last result's listItemId should match the row at position 1
      expect(results[2].listItemId).toBeDefined();
      expect(finalRows[0].id).toBe(results[2].listItemId);
      
      // All results should have listItemIds
      results.forEach((r) => {
        expect(r.listItemId).toBeDefined();
      });
    });
  });

  describe('REMOVEOLDEST overflow behavior (latest list functionality)', () => {
    it('should add item to top of list when list is not at max length', async () => {
      const listId = 'removeoldest-not-full';
      subsplashMock.createList(listId, 'Latest List');
      
      // Create a list with 2 items (not at max length of 4)
      const initialRows: SubsplashListRow[] = [
        {
          id: 'row-1',
          app_key: '9XTSHD',
          method: 'static',
          position: 1,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-1' } 
          }
        },
        {
          id: 'row-2',
          app_key: '9XTSHD',
          method: 'static',
          position: 2,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-2' } 
          }
        }
      ];
      subsplashMock.listRows.set(listId, initialRows);
      
      // Create Firestore document with REMOVEOLDEST behavior
      await createListDocument({
        subsplashId: listId,
        title: 'Latest List',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 2,
      });
      
      const mediaItem = { id: 'new-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 4
        }
      };

      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
      }
      
      // Verify the item was added at the top
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(3); // 2 existing + 1 new
      
      // New item should be at position 1 (top)
      expect(rows[0]._embedded['media-item']?.id).toBe('new-item');
      expect(rows[0].position).toBe(1);
      if (result[0].status === 'success') {
        expect(rows[0].id).toBe(result[0].listItemId);
      }
      
      // Previous top item should be at position 2
      expect(rows[1]._embedded['media-item']?.id).toBe('item-1');
      expect(rows[1].position).toBe(2);
      
      // Previous second item should be at position 3
      expect(rows[2]._embedded['media-item']?.id).toBe('item-2');
      expect(rows[2].position).toBe(3);
    });

    it('should remove bottom item and add new item to top when list is at max length', async () => {
      const listId = 'removeoldest-full';
      subsplashMock.createList(listId, 'Full Latest List');
      
      // Create a list with 4 items (at max length of 4)
      const initialRows: SubsplashListRow[] = [
        {
          id: 'row-1',
          app_key: '9XTSHD',
          method: 'static',
          position: 1,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-1' } 
          }
        },
        {
          id: 'row-2',
          app_key: '9XTSHD',
          method: 'static',
          position: 2,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-2' } 
          }
        },
        {
          id: 'row-3',
          app_key: '9XTSHD',
          method: 'static',
          position: 3,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-3' } 
          }
        },
        {
          id: 'row-4',
          app_key: '9XTSHD',
          method: 'static',
          position: 4,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-4' } 
          }
        }
      ];
      subsplashMock.listRows.set(listId, initialRows);
      
      // Create Firestore document with REMOVEOLDEST behavior
      const firestoreListId = await createListDocument({
        subsplashId: listId,
        title: 'Full Latest List',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 4,
      });

      await Promise.all([
        createSermonDocument(buildSermon('sermon-1', 'item-1')),
        createSermonDocument(buildSermon('sermon-2', 'item-2')),
        createSermonDocument(buildSermon('sermon-3', 'item-3')),
        createSermonDocument(buildSermon('sermon-4', 'item-4')),
        createSermonDocument(buildSermon('sermon-new', 'new-item')),
      ]);

      const seedPublishedMembership = async (sermonId: string, subsplashId: string, rowId: string, position: number) => {
        await firestoreDB
          .collection('lists')
          .doc(firestoreListId)
          .collection('listItems')
          .doc(sermonId)
          .set({
            subsplashId,
            uploadStatus: {
              status: uploadStatus.UPLOADED,
              listItemId: rowId,
            },
            physicalPlacement: {
              firestoreListId,
              subsplashListId: listId,
              overflowDepth: 0,
              position,
              listItemId: rowId,
            },
            position,
          });

        await firestoreDB
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonLists')
          .doc(firestoreListId)
          .set({
            id: firestoreListId,
            subsplashId: listId,
            name: 'Full Latest List',
            title: 'Full Latest List',
            overflowBehavior: OverflowBehavior.REMOVEOLDEST,
            uploadStatus: {
              status: uploadStatus.UPLOADED,
              listItemId: rowId,
            },
            publishGeneration: 0,
          });
      };

      await Promise.all([
        seedPublishedMembership('sermon-1', 'item-1', 'row-1', 1),
        seedPublishedMembership('sermon-2', 'item-2', 'row-2', 2),
        seedPublishedMembership('sermon-3', 'item-3', 'row-3', 3),
        seedPublishedMembership('sermon-4', 'item-4', 'row-4', 4),
      ]);
      
      const mediaItem = { id: 'new-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 4
        }
      };

      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
      }
      
      // Verify the list still has 4 items (max length)
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(4);
      
      // New item should be at position 1 (top)
      expect(rows[0]._embedded['media-item']?.id).toBe('new-item');
      expect(rows[0].position).toBe(1);
      if (result[0].status === 'success') {
        expect(rows[0].id).toBe(result[0].listItemId);
      }
      
      // Previous items should shift down
      expect(rows[1]._embedded['media-item']?.id).toBe('item-1');
      expect(rows[1].position).toBe(2);
      
      expect(rows[2]._embedded['media-item']?.id).toBe('item-2');
      expect(rows[2].position).toBe(3);
      
      expect(rows[3]._embedded['media-item']?.id).toBe('item-3');
      expect(rows[3].position).toBe(4);
      
      // Bottom item (item-4) should be removed
      const item4Row = rows.find(r => r._embedded['media-item']?.id === 'item-4');
      expect(item4Row).toBeUndefined();

      const removedProjection = await firestoreDB
        .collection('lists')
        .doc(firestoreListId)
        .collection('listItems')
        .doc('sermon-4')
        .get();
      expect(removedProjection.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
      expect(removedProjection.data()?.physicalPlacement).toBeUndefined();

      const removedCanonical = await firestoreDB
        .collection('sermons')
        .doc('sermon-4')
        .collection('sermonLists')
        .doc(firestoreListId)
        .get();
      expect(removedCanonical.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
      expect(removedCanonical.data()?.publishGeneration).toBe(1);
    });

    it('heals a desynced latest list when Subsplash enforces 200 items but only returns 199 rows', async () => {
      const listId = 'removeoldest-desynced-200-199';
      subsplashMock.createList(listId, 'Latest List Desynced', 200, 200);
      subsplashMock.failPatchWhenAtCapacityWithNewRows(listId);

      const initialRows: SubsplashListRow[] = Array.from({ length: 199 }, (_, index) => ({
        id: `row-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static',
        position: index + 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: `item-${index + 1}` },
        },
      }));
      subsplashMock.listRows.set(listId, initialRows);

      await createListDocument({
        subsplashId: listId,
        title: 'Latest List Desynced',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 200,
      });
      await createSermonDocument(buildSermon('sermon-new', 'new-item'));

      const result = await addToListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem: { id: 'new-item', type: 'media-item' as const },
          maxListSize: 200,
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');

      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(199);
      expect(rows[0]._embedded['media-item']?.id).toBe('new-item');
      expect(rows[198]._embedded['media-item']?.id).toBe('item-198');
      expect(rows.some((row) => row._embedded['media-item']?.id === 'item-199')).toBe(false);
      expect(subsplashMock.getList(listId)?.list_rows_count).toBe(199);

      const patchEvents = subsplashMock
        .getHistory()
        .filter((entry) => entry.event === 'patch' && entry.listId === listId);
      expect(patchEvents.at(-1)?.rows).toHaveLength(199);
    });

    it('retries latest-list remove-oldest with one fewer visible row when Subsplash still rejects a 200-row patch', async () => {
      const listId = 'removeoldest-hidden-full-199-visible';
      subsplashMock.createList(listId, 'Latest List Hidden Full', 199, 200);
      subsplashMock.failPatchWhenHiddenCapacityIsFull(listId);

      const initialRows: SubsplashListRow[] = Array.from({ length: 199 }, (_, index) => ({
        id: `row-hidden-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static',
        position: index + 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: `hidden-item-${index + 1}` },
        },
      }));
      subsplashMock.listRows.set(listId, initialRows);

      await createListDocument({
        subsplashId: listId,
        title: 'Latest List Hidden Full',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 199,
      });
      await createSermonDocument(buildSermon('sermon-hidden-new', 'hidden-new-item'));

      const result = await addToListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem: { id: 'hidden-new-item', type: 'media-item' as const },
          maxListSize: 200,
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');

      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(199);
      expect(rows[0]._embedded['media-item']?.id).toBe('hidden-new-item');
      expect(rows[198]._embedded['media-item']?.id).toBe('hidden-item-198');
      expect(rows.some((row) => row._embedded['media-item']?.id === 'hidden-item-199')).toBe(false);

      const patchEvents = subsplashMock
        .getHistory()
        .filter((entry) => entry.event === 'patch' && entry.listId === listId);
      expect(patchEvents.at(-1)?.rows).toHaveLength(199);
    });
  });
});
