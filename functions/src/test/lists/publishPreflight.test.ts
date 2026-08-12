import { OverflowBehavior } from '@upperroom/shared/types/List';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { subsplashMock, type AddToListHandler, type TestRequest } from '../addToList/mocks';
import addToList from '../../addToList';
import { clearFirestore, createListDocument, createSermonDocument } from '../addToList/firestoreHelpers';
import * as sentryModule from '../../sentry';

const addToListHandler = addToList as unknown as AddToListHandler;

describe('publish strict preflight', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearFirestore();
    subsplashMock.reset();
  });

  it('allows a simple non-overflow publish even when Firebase does not fully mirror the published remote list state', async () => {
    const rootSubsplashListId = 'simple-publish-root';
    const rootFirestoreListId = 'simple-publish-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 5);
    subsplashMock.listRows.set(rootSubsplashListId, [
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-1' },
        },
      },
    ]);

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootSubsplashListId],
        mediaItem: { id: 'media-2', type: 'media-item' },
        maxListSize: 5,
        operationKey: 'simple-publish-allowed',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'success',
      }),
    ]);
    expect(subsplashMock.getListRows(rootSubsplashListId).map((row) => row._embedded['media-item']?.id)).toEqual([
      'media-2',
      'media-1',
    ]);
  });

  it('allows overflow-causing publish when the published Firebase and Subsplash state differ', async () => {
    const rootSubsplashListId = 'overflow-publish-root';
    const rootFirestoreListId = 'overflow-publish-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 5);
    subsplashMock.listRows.set(rootSubsplashListId, [
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-1' },
        },
      },
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-2' },
        },
      },
      {
        id: 'row-3',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-3' },
        },
      },
      {
        id: 'row-4',
        app_key: '9XTSHD',
        method: 'static',
        position: 4,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-4' },
        },
      },
      {
        id: 'row-5',
        app_key: '9XTSHD',
        method: 'static',
        position: 5,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-5' },
        },
      },
    ]);

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 5,
      logicalCount: 5,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });
    await firebaseAdmin.firestore().collection('lists').doc(rootFirestoreListId).collection('listItems').doc('sermon-1').set({
      id: 'sermon-1',
      title: 'Test 1',
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
      subsplashId: 'media-1',
      position: 1,
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
    });

    subsplashMock.clearHistory();

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootSubsplashListId],
        mediaItem: { id: 'media-6', type: 'media-item' },
        maxListSize: 5,
        operationKey: 'overflow-publish-blocked',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'success',
      }),
    ]);
    expect(subsplashMock.getHistory().length).toBeGreaterThan(0);
    expect(subsplashMock.getListRows(rootSubsplashListId).length).toBeGreaterThanOrEqual(5);
  });

  it('allows overflow-causing publish even when Firebase has no local published mirror for an already-full remote list', async () => {
    const rootSubsplashListId = 'overflow-publish-unmirrored-root';
    const rootFirestoreListId = 'overflow-publish-unmirrored-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 5);
    subsplashMock.listRows.set(
      rootSubsplashListId,
      Array.from({ length: 5 }, (_, index) => ({
        id: `row-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static',
        position: index + 1,
        type: 'media-item' as const,
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: `media-${index + 1}` },
        },
      }))
    );

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    subsplashMock.clearHistory();

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootSubsplashListId],
        mediaItem: { id: 'media-6', type: 'media-item' },
        maxListSize: 5,
        operationKey: 'overflow-publish-unmirrored-blocked',
      },
    };

    const result = await addToListHandler(request);

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'success',
      }),
    ]);
    expect(subsplashMock.getHistory().length).toBeGreaterThan(0);
    expect(subsplashMock.getListRows(rootSubsplashListId).map((row) => row._embedded['media-item']?.id)).toContain(
      'media-6'
    );
  });

  it('allows latest-list publish with a large remote-only published set and preserves those current remote rows', async () => {
    const rootSubsplashListId = 'latest-remote-only-large-root';
    const rootFirestoreListId = 'latest-remote-only-large-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Latest', 199, 200);
    subsplashMock.failPatchWhenHiddenCapacityIsFull(rootSubsplashListId);
    subsplashMock.listRows.set(
      rootSubsplashListId,
      Array.from({ length: 199 }, (_, index) => ({
        id: `row-${index + 1}`,
        app_key: '9XTSHD',
        method: 'static',
        position: index + 1,
        type: 'media-item' as const,
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: `remote-only-${index + 1}` },
        },
      }))
    );

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Latest',
      overflowBehavior: OverflowBehavior.REMOVEOLDEST,
      count: 199,
      logicalCount: 199,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    await createSermonDocument({
      id: 'sermon-new-latest-remote-only',
      title: 'Newest Sermon',
      subtitle: '',
      description: '',
      speakers: [],
      dateMillis: Date.now(),
      sourceStartTime: 0,
      durationSeconds: 1000,
      topics: [],
      dateString: '4/5/2026',
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
      images: [],
      createdAtMillis: Date.now(),
      editedAtMillis: Date.now(),
      subsplashId: 'brand-new-media-item',
      numberOfLists: 1,
      numberOfListsUploadedTo: 0,
    });

    subsplashMock.clearHistory();

    const result = await addToListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootSubsplashListId],
        mediaItem: { id: 'brand-new-media-item', type: 'media-item' },
        maxListSize: 200,
        operationKey: 'latest-remote-only-large-publish',
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'success',
      }),
    ]);

    const rows = subsplashMock.getListRows(rootSubsplashListId);
    expect(rows).toHaveLength(199);
    expect(rows[0]._embedded['media-item']?.id).toBe('brand-new-media-item');
    expect(rows[1]._embedded['media-item']?.id).toBe('remote-only-1');
    expect(rows.some((row) => row._embedded['media-item']?.id === 'remote-only-198')).toBe(true);
    expect(rows.some((row) => row._embedded['media-item']?.id === 'remote-only-199')).toBe(false);
  });

  it('blocks publish when the current Subsplash chain has malformed continuation rows', async () => {
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);
    const rootSubsplashListId = 'publish-blocked-invalid-continuation-root';
    const overflowSubsplashListId = 'publish-blocked-invalid-continuation-overflow';
    const straySubsplashListId = 'publish-blocked-invalid-continuation-stray';
    const rootFirestoreListId = 'publish-blocked-invalid-continuation-root-firestore';
    const overflowFirestoreListId = 'publish-blocked-invalid-continuation-overflow-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 3, 5);
    subsplashMock.createList(overflowSubsplashListId, 'Overflow List', 0, 5);
    subsplashMock.createList(straySubsplashListId, 'Stray List', 0, 5);
    subsplashMock.listRows.set(rootSubsplashListId, [
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          'media-item': { id: 'media-1' },
        },
      },
      {
        id: 'row-link-expected',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'list',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          list: { id: overflowSubsplashListId },
        },
      },
      {
        id: 'row-link-stray',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'list',
        _embedded: {
          'source-list': { id: rootSubsplashListId },
          list: { id: straySubsplashListId },
        },
      },
    ]);
    subsplashMock.listRows.set(overflowSubsplashListId, []);

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      logicalCount: 1,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
      moreSermonsRef: overflowSubsplashListId,
    });
    await createListDocument({
      id: overflowFirestoreListId,
      subsplashId: overflowSubsplashListId,
      title: 'Overflow List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 1,
    });

    subsplashMock.clearHistory();

    const result = await addToListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootSubsplashListId],
        mediaItem: { id: 'media-2', type: 'media-item' },
        maxListSize: 5,
        operationKey: 'publish-blocked-invalid-continuation',
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'error',
        errorCode: 'failed-precondition',
        errorDetails: expect.objectContaining({
          code: 'PUBLISHED_LIST_DRIFT_BLOCKED',
        }),
      }),
    ]);
    expect(sentrySpy).not.toHaveBeenCalled();
    expect(subsplashMock.getHistory()).toEqual([]);
    expect(subsplashMock.getListRows(rootSubsplashListId).map((row) => row.id)).toEqual([
      'row-1',
      'row-link-expected',
      'row-link-stray',
    ]);
  });

  it('keeps Firebase published order aligned across simple prepends so the first overflow publish does not trip strict preflight', async () => {
    const rootSubsplashListId = 'overflow-preflight-sequence-root';
    const rootFirestoreListId = 'overflow-preflight-sequence-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 3);

    await createListDocument({
      id: rootFirestoreListId,
      subsplashId: rootSubsplashListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    const firestore = firebaseAdmin.firestore();
    const listItemsRef = firestore.collection('lists').doc(rootFirestoreListId).collection('listItems');

    const persistClientStyleSuccess = async (
      sermonId: string,
      mediaItemId: string,
      response: Awaited<ReturnType<AddToListHandler>>
    ) => {
      const result = response[0];
      if (result.status !== 'success') {
        throw new Error(`Expected success for ${sermonId}`);
      }

      await listItemsRef.doc(sermonId).set(
        {
          uploadStatus: { status: uploadStatus.UPLOADED, listItemId: result.listItemId },
          physicalPlacement: result.actualPlacement,
          subsplashId: mediaItemId,
        },
        { merge: true }
      );

      await firestore
        .collection('sermons')
        .doc(sermonId)
        .collection('sermonLists')
        .doc(rootFirestoreListId)
        .set(
          {
            id: rootFirestoreListId,
            subsplashId: rootSubsplashListId,
            name: 'Root List',
            title: 'Root List',
            overflowBehavior: OverflowBehavior.CREATENEWLIST,
            isRootList: true,
            isMoreSermonsList: false,
            rootListId: rootFirestoreListId,
            overflowDepth: 0,
            uploadStatus: { status: uploadStatus.UPLOADED, listItemId: result.listItemId },
          },
          { merge: true }
        );
    };

    for (const index of [1, 2, 3, 4]) {
      const sermonId = `sermon-${index}`;
      const mediaItemId = `media-${index}`;

      await createSermonDocument({
        id: sermonId,
        title: `Test ${index}`,
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now() + index,
        sourceStartTime: 0,
        durationSeconds: 1000,
        topics: [],
        dateString: '3/15/2026',
        status: {
          subsplash: uploadStatus.NOT_UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now() + index,
        editedAtMillis: Date.now() + index,
        subsplashId: mediaItemId,
        numberOfLists: 1,
        numberOfListsUploadedTo: 0,
      });

      await listItemsRef.doc(sermonId).set({
        id: sermonId,
        title: `Test ${index}`,
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now() + index,
        sourceStartTime: 0,
        durationSeconds: 1000,
        topics: [],
        dateString: '3/15/2026',
        status: {
          subsplash: uploadStatus.NOT_UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: sermonStatusType.PROCESSED,
        },
        images: [],
        createdAtMillis: Date.now() + index,
        editedAtMillis: Date.now() + index,
        subsplashId: mediaItemId,
        position: index,
      });
    }

    const publish = async (index: number) =>
      addToListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootSubsplashListId],
          mediaItem: { id: `media-${index}`, type: 'media-item' },
          maxListSize: 3,
          operationKey: `overflow-preflight-sequence-${index}`,
        },
      });

    for (const index of [1, 2, 3]) {
      const response = await publish(index);
      expect(response).toEqual([
        expect.objectContaining({
          listId: rootSubsplashListId,
          status: 'success',
        }),
      ]);
      await persistClientStyleSuccess(`sermon-${index}`, `media-${index}`, response);
    }

    const fourthResponse = await publish(4);
    expect(fourthResponse).toEqual([
      expect.objectContaining({
        listId: rootSubsplashListId,
        status: 'success',
      }),
    ]);

    const rootRows = subsplashMock.getListRows(rootSubsplashListId);
    const overflowLink = rootRows.find((row) => row.type === 'list');
    expect(rootRows.map((row) => row.type === 'list' ? `list:${row._embedded.list?.id}` : row._embedded['media-item']?.id)).toEqual([
      'media-4',
      'media-3',
      expect.stringMatching(/^list:/),
    ]);
    expect(overflowLink?._embedded.list?.id).toBeTruthy();

    const overflowRows = subsplashMock.getListRows(overflowLink!._embedded.list!.id);
    expect(overflowRows.map((row) => row._embedded['media-item']?.id)).toEqual(['media-2', 'media-1']);

    const mirroredItems = await listItemsRef.orderBy('position').get();
    expect(
      mirroredItems.docs.map((doc) => ({
        id: doc.id,
        position: doc.data().position,
        physicalList: doc.data().physicalPlacement?.firestoreListId,
        overflowDepth: doc.data().physicalPlacement?.overflowDepth,
      }))
    ).toEqual([
      expect.objectContaining({ id: 'sermon-4', position: 1, physicalList: rootFirestoreListId, overflowDepth: 0 }),
      expect.objectContaining({ id: 'sermon-3', position: 2, physicalList: rootFirestoreListId, overflowDepth: 0 }),
      expect.objectContaining({ id: 'sermon-2', position: 3, overflowDepth: 1 }),
      expect.objectContaining({ id: 'sermon-1', position: 4, overflowDepth: 1 }),
    ]);
  });
});
