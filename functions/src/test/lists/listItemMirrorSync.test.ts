import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType, uploadStatus, type Sermon } from '@upperroom/shared/types/SermonTypes';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { syncListItemMirrorByFirestoreListId } from '../../helpers/listItemMirrorSync';
import { clearFirestore, createListDocument, createSermonDocument } from '../addToList/firestoreHelpers';
import type { SubsplashListRow } from '../../types/Subsplash';

const firestore = firebaseAdmin.firestore();

const stripUndefined = (value: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, fieldValue]) => fieldValue !== undefined)
  );

const buildSermon = (overrides: Partial<Sermon> & Pick<Sermon, 'id'>): Sermon => ({
  id: overrides.id,
  title: overrides.title ?? 'Test Sermon',
  subtitle: overrides.subtitle ?? '',
  description: overrides.description ?? '',
  dateMillis: overrides.dateMillis ?? Date.now(),
  sourceStartTime: overrides.sourceStartTime ?? 0,
  durationSeconds: overrides.durationSeconds ?? 0,
  speakers: overrides.speakers ?? [],
  topics: overrides.topics ?? [],
  dateString: overrides.dateString ?? new Date().toLocaleDateString(),
  status: overrides.status ?? {
    soundCloud: uploadStatus.NOT_UPLOADED,
    subsplash: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PROCESSED,
  },
  images: overrides.images ?? [],
  numberOfLists: overrides.numberOfLists ?? 0,
  numberOfListsUploadedTo: overrides.numberOfListsUploadedTo ?? 0,
  createdAtMillis: overrides.createdAtMillis ?? Date.now(),
  editedAtMillis: overrides.editedAtMillis ?? Date.now(),
  subsplashId: overrides.subsplashId,
  uploaderId: overrides.uploaderId,
  approverId: overrides.approverId,
  soundCloudTrackId: overrides.soundCloudTrackId,
  soundCloudTrackUrl: overrides.soundCloudTrackUrl,
  youtubeUrl: overrides.youtubeUrl,
  seriesId: overrides.seriesId,
});

const buildRow = (mediaItemId: string, position: number, rowId: string): SubsplashListRow => ({
  id: rowId,
  app_key: 'test-app',
  method: 'static',
  position,
  type: 'media-item',
  _embedded: {
    'source-list': { id: 'root-subsplash-list' },
    'media-item': { id: mediaItemId },
  },
});

describe('syncListItemMirrorByFirestoreListId', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('preserves unpublished local memberships while reconciling uploaded remote rows', async () => {
    const firestoreListId = 'root-firestore-list';

    await createListDocument({
      id: firestoreListId,
      subsplashId: 'root-subsplash-list',
      title: 'Speaker List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: firestoreListId,
      overflowDepth: 0,
    });

    const unpublishedSermon = buildSermon({ id: 'sermon-unpublished' });
    const publishedSermon = buildSermon({ id: 'sermon-published', subsplashId: 'remote-media-1' });
    const staleUploadedSermon = buildSermon({ id: 'sermon-stale', subsplashId: 'remote-media-stale' });

    await Promise.all([
      createSermonDocument(unpublishedSermon),
      createSermonDocument(publishedSermon),
      createSermonDocument(staleUploadedSermon),
    ]);

    const listItemsRef = firestore.collection('lists').doc(firestoreListId).collection('listItems');
    await Promise.all([
      listItemsRef.doc(unpublishedSermon.id).set(stripUndefined(unpublishedSermon)),
      listItemsRef.doc(publishedSermon.id).set({
        ...stripUndefined(publishedSermon),
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: 'old-row-id',
        },
      }),
      listItemsRef.doc(staleUploadedSermon.id).set({
        ...stripUndefined(staleUploadedSermon),
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: 'stale-row-id',
        },
      }),
    ]);

    await syncListItemMirrorByFirestoreListId(firestoreListId, [buildRow('remote-media-1', 1, 'new-row-id')]);

    const [unpublishedSnapshot, publishedSnapshot, staleSnapshot] = await Promise.all([
      listItemsRef.doc(unpublishedSermon.id).get(),
      listItemsRef.doc(publishedSermon.id).get(),
      listItemsRef.doc(staleUploadedSermon.id).get(),
    ]);

    expect(unpublishedSnapshot.exists).toBe(true);
    expect(unpublishedSnapshot.data()?.uploadStatus).toBeUndefined();
    expect(publishedSnapshot.exists).toBe(true);
    expect(publishedSnapshot.data()?.uploadStatus).toEqual({
      status: uploadStatus.UPLOADED,
      listItemId: 'new-row-id',
    });
    expect(staleSnapshot.exists).toBe(true);
    expect(staleSnapshot.data()?.uploadStatus).toEqual({
      status: uploadStatus.UPLOADED,
      listItemId: 'stale-row-id',
    });
  });
});
