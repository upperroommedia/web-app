import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { subsplashMock } from '../addToList/mocks';
import { syncRootMembershipPlacements } from '../../helpers/listOverflowChain';
import { clearFirestore, createListDocument, createSermonDocument } from '../addToList/firestoreHelpers';

const firestore = firebaseAdmin.firestore();

describe('syncRootMembershipPlacements', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
  });

  it('falls back to the existing root projection row when the sermon lookup misses the current Subsplash id', async () => {
    const rootSubsplashListId = 'sync-root-subsplash';
    const rootFirestoreListId = 'sync-root-firestore';

    subsplashMock.createList(rootSubsplashListId, 'Root List', 1, 5);
    subsplashMock.listRows.set(rootSubsplashListId, [
      {
        id: 'remote-row-1',
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
      count: 1,
      logicalCount: 1,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreListId,
      overflowDepth: 0,
    });

    await createSermonDocument({
      id: 'sermon-1',
      title: 'Test Sermon',
      subtitle: '',
      description: '',
      speakers: [],
      dateMillis: Date.now(),
      sourceStartTime: 0,
      durationSeconds: 1000,
      topics: [],
      dateString: '4/5/2026',
      status: {
        subsplash: uploadStatus.UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
      images: [],
      createdAtMillis: Date.now(),
      editedAtMillis: Date.now(),
      subsplashId: 'stale-media-id',
      numberOfLists: 1,
      numberOfListsUploadedTo: 1,
    });

    await firestore
      .collection('lists')
      .doc(rootFirestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .set({
        id: 'sermon-1',
        title: 'Test Sermon',
        subtitle: '',
        description: '',
        speakers: [],
        dateMillis: Date.now(),
        sourceStartTime: 0,
        durationSeconds: 1000,
        topics: [],
        dateString: '4/5/2026',
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
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: 'stale-row-id',
        },
      });

    await firestore
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(rootFirestoreListId)
      .set({
        id: rootFirestoreListId,
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: 'stale-row-id',
        },
        publishGeneration: 0,
      });

    await syncRootMembershipPlacements(rootSubsplashListId, 'fake-token');

    const rootProjection = await firestore
      .collection('lists')
      .doc(rootFirestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .get();
    expect(rootProjection.data()?.uploadStatus).toEqual({
      status: uploadStatus.UPLOADED,
      listItemId: 'remote-row-1',
    });
    expect(rootProjection.data()?.physicalPlacement).toEqual({
      firestoreListId: rootFirestoreListId,
      subsplashListId: rootSubsplashListId,
      overflowDepth: 0,
      position: 1,
      listItemId: 'remote-row-1',
    });

    const canonicalMembership = await firestore
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(rootFirestoreListId)
      .get();
    expect(canonicalMembership.data()?.uploadStatus).toEqual({
      status: uploadStatus.UPLOADED,
      listItemId: 'remote-row-1',
    });
  });
});
