import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { clearFirestore, createListDocument, createSermonDocument } from '../../addToList/firestoreHelpers';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { syncRootProjectionStatusFromCanonical } from '../../../helpers/syncRootProjectionStatusFromCanonical';

const firestore = firebaseAdmin.firestore();

describe('syncRootProjectionStatusFromCanonical', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('clears stale published projection status when canonical membership is not uploaded', async () => {
    await createListDocument({
      id: 'root-list',
      subsplashId: 'subsplash-root',
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isRootList: true,
      rootListId: 'root-list',
      overflowDepth: 0,
    });

    await createSermonDocument({
      id: 'sermon-1',
      title: 'Test 1',
      subtitle: '',
      description: '',
      dateMillis: 1,
      sourceStartTime: 0,
      speakers: [],
      topics: [],
      dateString: '',
      images: [],
      uploaderId: 'user-1',
      createdAtMillis: 1,
      editedAtMillis: 1,
      numberOfLists: 1,
      numberOfListsUploadedTo: 1,
      durationSeconds: 0,
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
      subsplashId: 'media-1',
    });

    await firestore.collection('lists').doc('root-list').collection('listItems').doc('sermon-1').set({
      id: 'sermon-1',
      title: 'Test 1',
      subsplashId: 'media-1',
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'stale-row' },
      physicalPlacement: {
        firestoreListId: 'root-list',
        subsplashListId: 'subsplash-root',
        overflowDepth: 0,
        position: 1,
        listItemId: 'stale-row',
      },
    });

    await syncRootProjectionStatusFromCanonical({
      sermonId: 'sermon-1',
      rootListId: 'root-list',
      canonicalMembership: {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      },
    });

    const projectionSnapshot = await firestore
      .collection('lists')
      .doc('root-list')
      .collection('listItems')
      .doc('sermon-1')
      .get();

    expect(projectionSnapshot.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
    expect(projectionSnapshot.data()?.physicalPlacement).toBeUndefined();
  });

  it('mirrors canonical uploaded status onto an existing root projection doc', async () => {
    await createListDocument({
      id: 'root-list',
      subsplashId: 'subsplash-root',
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isRootList: true,
      rootListId: 'root-list',
      overflowDepth: 0,
    });

    await firestore.collection('lists').doc('root-list').collection('listItems').doc('sermon-1').set({
      id: 'sermon-1',
      title: 'Test 1',
      subsplashId: 'media-1',
    });

    await syncRootProjectionStatusFromCanonical({
      sermonId: 'sermon-1',
      rootListId: 'root-list',
      canonicalMembership: {
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
      },
    });

    const projectionSnapshot = await firestore
      .collection('lists')
      .doc('root-list')
      .collection('listItems')
      .doc('sermon-1')
      .get();

    expect(projectionSnapshot.data()?.uploadStatus).toEqual({
      status: uploadStatus.UPLOADED,
      listItemId: 'row-1',
    });
  });

  it('does not create a phantom projection doc when no root projection exists', async () => {
    await syncRootProjectionStatusFromCanonical({
      sermonId: 'sermon-1',
      rootListId: 'root-list',
      canonicalMembership: {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      },
    });

    const projectionSnapshot = await firestore
      .collection('lists')
      .doc('root-list')
      .collection('listItems')
      .doc('sermon-1')
      .get();

    expect(projectionSnapshot.exists).toBe(false);
  });
});
