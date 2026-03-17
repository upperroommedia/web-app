import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { sermonStatusType, uploadStatus, type Sermon } from '@upperroom/shared/types/SermonTypes';
import { subsplashMock } from '../addToList/mocks';
import { auditPublishedListDrift, resolvePublishedListDrift } from '../../helpers/publishedListDrift';
import { clearFirestore, createListDocument, createSermonDocument } from '../addToList/firestoreHelpers';
import type { SubsplashListRow } from '../../types/Subsplash';

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

const createUnsupportedRow = (
  listId: string,
  rowId: string,
  unsupportedType: string,
  embeddedId: string,
  position: number
): SubsplashListRow => ({
  id: rowId,
  app_key: '9XTSHD',
  method: 'static',
  position,
  type: unsupportedType,
  _embedded: {
    'source-list': { id: listId },
    [unsupportedType]: { id: embeddedId },
  },
} as unknown as SubsplashListRow);

const buildSermon = (index: number): Sermon => ({
  id: `sermon-${index}`,
  title: `Test ${index}`,
  subtitle: 'Subtitle',
  description: `Description ${index}`,
  speakers: [],
  dateMillis: 1_710_000_000_000 + index,
  sourceStartTime: 0,
  durationSeconds: 1800,
  topics: [],
  status: {
    subsplash: uploadStatus.UPLOADED,
    soundCloud: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PROCESSED,
  },
  images: [],
  createdAtMillis: 1_710_000_000_000 + index,
  editedAtMillis: 1_710_000_000_000 + index,
  subsplashId: `media-${index}`,
});

const seedPublishedOverflowFixture = async (
  options?: {
    unpublishedIds?: string[];
    writeRootProjection?: boolean;
    writeSermonLists?: boolean;
  }
) => {
  const rootFirestoreListId = 'drift-root';
  const overflowFirestoreListId = 'drift-overflow';
  const tailFirestoreListId = 'drift-tail';
  const rootSubsplashListId = 'subsplash-root';
  const overflowSubsplashListId = 'subsplash-overflow';
  const tailSubsplashListId = 'subsplash-tail';
  const unpublishedIds = new Set(options?.unpublishedIds ?? []);
  const writeRootProjection = options?.writeRootProjection ?? true;
  const writeSermonLists = options?.writeSermonLists ?? true;

  subsplashMock.createList(rootSubsplashListId, 'Root List', 0, 5);
  subsplashMock.createList(overflowSubsplashListId, 'More Root List sermons', 0, 5, 'Page 1');
  subsplashMock.createList(tailSubsplashListId, 'More Root List sermons', 0, 5, 'Page 2');

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
    isMoreSermonsList: false,
    rootListId: rootFirestoreListId,
    overflowDepth: 0,
    moreSermonsRef: overflowSubsplashListId,
  });
  await createListDocument({
    id: overflowFirestoreListId,
    subsplashId: overflowSubsplashListId,
    title: 'More Root List sermons',
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    count: 4,
    isRootList: false,
    isMoreSermonsList: true,
    rootListId: rootFirestoreListId,
    overflowDepth: 1,
    moreSermonsRef: tailSubsplashListId,
  });
  await createListDocument({
    id: tailFirestoreListId,
    subsplashId: tailSubsplashListId,
    title: 'More Root List sermons',
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    count: 5,
    isRootList: false,
    isMoreSermonsList: true,
    rootListId: rootFirestoreListId,
    overflowDepth: 2,
  });

  const rootListSnapshot = await firestore.collection('lists').doc(rootFirestoreListId).get();
  const rootListData = rootListSnapshot.data() as Record<string, unknown>;

  for (let index = 1; index <= 13; index += 1) {
    const sermon = buildSermon(index);
    const isPublished = !unpublishedIds.has(sermon.id);
    await createSermonDocument({
      ...sermon,
      status: {
        ...sermon.status,
        subsplash: isPublished ? uploadStatus.UPLOADED : uploadStatus.NOT_UPLOADED,
      },
    });

    const physicalPlacement =
      index <= 4
        ? {
            firestoreListId: rootFirestoreListId,
            subsplashListId: rootSubsplashListId,
            overflowDepth: 0,
            position: index,
          }
        : index <= 8
        ? {
            firestoreListId: overflowFirestoreListId,
            subsplashListId: overflowSubsplashListId,
            overflowDepth: 1,
            position: index - 4,
          }
        : {
            firestoreListId: tailFirestoreListId,
            subsplashListId: tailSubsplashListId,
            overflowDepth: 2,
            position: index - 8,
          };

    if (writeRootProjection) {
      await firestore
        .collection('lists')
        .doc(rootFirestoreListId)
        .collection('listItems')
        .doc(sermon.id)
        .set({
          ...sermon,
          position: index,
          uploadStatus: isPublished
            ? { status: uploadStatus.UPLOADED, listItemId: `row-${index}` }
            : { status: uploadStatus.NOT_UPLOADED },
          ...(isPublished ? { physicalPlacement } : {}),
        });
    }

    if (writeSermonLists) {
      await firestore
        .collection('sermons')
        .doc(sermon.id)
        .collection('sermonLists')
        .doc(rootFirestoreListId)
        .set({
          ...rootListData,
          id: rootFirestoreListId,
          uploadStatus: isPublished
            ? { status: uploadStatus.UPLOADED, listItemId: `row-${index}` }
            : { status: uploadStatus.NOT_UPLOADED },
        });
    }
  }

  return {
    rootFirestoreListId,
    rootSubsplashListId,
    overflowFirestoreListId,
    overflowSubsplashListId,
    tailFirestoreListId,
    tailSubsplashListId,
  };
};

describe('published list drift', () => {
  beforeEach(async () => {
    await clearFirestore();
    await firebaseAdmin.database().ref('subsplashLocks').remove();
    subsplashMock.reset();
  });

  it('reports IN_SYNC for a 13-sermon 4+4+5 published overflow chain', async () => {
    const fixture = await seedPublishedOverflowFixture();

    const result = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(result.inSync).toBe(true);
    expect(result.canReorder).toBe(true);
    expect(result.canOverflowPublish).toBe(true);
    expect(result.localPublishedItems).toHaveLength(13);
    expect(result.remotePublishedItems).toHaveLength(13);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'IN_SYNC',
      }),
    ]);
  });

  it('detects order mismatch within a single physical page', async () => {
    const fixture = await seedPublishedOverflowFixture();

    subsplashMock.listRows.set(fixture.rootSubsplashListId, [
      createMediaRow(fixture.rootSubsplashListId, 'row-2', 'media-2', 1),
      createMediaRow(fixture.rootSubsplashListId, 'row-1', 'media-1', 2),
      createMediaRow(fixture.rootSubsplashListId, 'row-3', 'media-3', 3),
      createMediaRow(fixture.rootSubsplashListId, 'row-4', 'media-4', 4),
      createOverflowRow(fixture.rootSubsplashListId, 'row-link-1', fixture.overflowSubsplashListId, 5),
    ]);

    const result = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(result.inSync).toBe(false);
    expect(result.canReorder).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ORDER_MISMATCH',
        }),
      ])
    );
  });

  it('detects remote-only matched and local-only published membership mismatches', async () => {
    const fixture = await seedPublishedOverflowFixture({ unpublishedIds: ['sermon-5'] });

    subsplashMock.listRows.set(fixture.tailSubsplashListId, [
      createMediaRow(fixture.tailSubsplashListId, 'row-9', 'media-9', 1),
      createMediaRow(fixture.tailSubsplashListId, 'row-10', 'media-10', 2),
      createMediaRow(fixture.tailSubsplashListId, 'row-11', 'media-11', 3),
      createMediaRow(fixture.tailSubsplashListId, 'row-12', 'media-12', 4),
      // Remove media-13 to create LOCAL_ONLY_PUBLISHED.
    ]);

    const result = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REMOTE_ONLY_MATCHED', sermonId: 'sermon-5' }),
        expect.objectContaining({ code: 'LOCAL_ONLY_PUBLISHED', sermonId: 'sermon-13' }),
        expect.objectContaining({ code: 'MEMBERSHIP_MISMATCH' }),
      ])
    );
  });

  it('detects invalid continuation rows', async () => {
    const fixture = await seedPublishedOverflowFixture();

    subsplashMock.listRows.set(fixture.overflowSubsplashListId, [
      createOverflowRow(fixture.overflowSubsplashListId, 'row-link-2', fixture.tailSubsplashListId, 1),
      createMediaRow(fixture.overflowSubsplashListId, 'row-5', 'media-5', 2),
      createMediaRow(fixture.overflowSubsplashListId, 'row-6', 'media-6', 3),
      createMediaRow(fixture.overflowSubsplashListId, 'row-7', 'media-7', 4),
      createMediaRow(fixture.overflowSubsplashListId, 'row-8', 'media-8', 5),
    ]);

    const result = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONTINUATION_ROW_INVALID',
          firestoreListId: fixture.overflowFirestoreListId,
        }),
      ])
    );
  });

  it('flags unsupported remote published row types and blocks explicit resolution', async () => {
    const fixture = await seedPublishedOverflowFixture();

    subsplashMock.listRows.set(fixture.tailSubsplashListId, [
      createMediaRow(fixture.tailSubsplashListId, 'row-9', 'media-9', 1),
      createMediaRow(fixture.tailSubsplashListId, 'row-10', 'media-10', 2),
      createMediaRow(fixture.tailSubsplashListId, 'row-11', 'media-11', 3),
      createMediaRow(fixture.tailSubsplashListId, 'row-12', 'media-12', 4),
      createUnsupportedRow(fixture.tailSubsplashListId, 'row-series', 'series-item', 'series-remote-1', 5),
    ]);

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(drift.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REMOTE_ONLY_UNSUPPORTED_TYPE',
          mediaItemId: 'series-remote-1',
          mediaType: 'series-item',
        }),
      ])
    );

    await expect(
      resolvePublishedListDrift({
        listId: fixture.rootFirestoreListId,
        token: 'fake-token',
        strategy: 'FIREBASE_FROM_SUBSPLASH',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('treats legacy published projection rows without uploadStatus as published when status/placement prove they were synced', async () => {
    const fixture = await seedPublishedOverflowFixture();

    const projectionSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .get();

    const batch = firestore.batch();
    projectionSnapshot.docs.forEach((docSnapshot) => {
      batch.set(
        docSnapshot.ref,
        {
          uploadStatus: firebaseAdmin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
    });
    await batch.commit();

    const result = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(result.inSync).toBe(true);
    expect(result.localPublishedItems).toHaveLength(13);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'IN_SYNC',
      }),
    ]);
  });

  it('ignores stale root projection upload status when canonical membership is already NOT_UPLOADED', async () => {
    const fixture = await seedPublishedOverflowFixture();
    const staleSermon = buildSermon(2);

    await firestore
      .collection('sermons')
      .doc(staleSermon.id)
      .collection('sermonLists')
      .doc(fixture.rootFirestoreListId)
      .set(
        {
          uploadStatus: { status: uploadStatus.NOT_UPLOADED },
        },
        { merge: true }
      );

    const driftState = await auditPublishedListDrift(fixture.rootFirestoreListId, 'test-token');

    expect(driftState.localPublishedItems.map((item) => item.sermonId)).not.toContain(staleSermon.id);
    expect(
      driftState.issues.some(
        (issue) => issue.code === 'LOCAL_ONLY_PUBLISHED' && issue.sermonId === staleSermon.id
      )
    ).toBe(false);
  });

  it('updates only the published subset when resolving Firebase from Subsplash order', async () => {
    const fixture = await seedPublishedOverflowFixture({ unpublishedIds: ['sermon-12'] });

    await createSermonDocument({
      ...buildSermon(99),
      id: 'sermon-99',
      subsplashId: 'media-99',
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
    });
    await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .doc('sermon-99')
      .set({
        ...buildSermon(99),
        id: 'sermon-99',
        subsplashId: 'media-99',
        position: 14,
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      });
    await firestore
      .collection('sermons')
      .doc('sermon-99')
      .collection('sermonLists')
      .doc(fixture.rootFirestoreListId)
      .set({
        id: fixture.rootFirestoreListId,
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      });

    subsplashMock.listRows.set(fixture.rootSubsplashListId, [
      createMediaRow(fixture.rootSubsplashListId, 'row-2', 'media-2', 1),
      createMediaRow(fixture.rootSubsplashListId, 'row-1', 'media-1', 2),
      createMediaRow(fixture.rootSubsplashListId, 'row-3', 'media-3', 3),
      createMediaRow(fixture.rootSubsplashListId, 'row-4', 'media-4', 4),
      createOverflowRow(fixture.rootSubsplashListId, 'row-link-1', fixture.overflowSubsplashListId, 5),
    ]);

    const result = await resolvePublishedListDrift({
      listId: fixture.rootFirestoreListId,
      token: 'fake-token',
      strategy: 'FIREBASE_FROM_SUBSPLASH',
    });

    expect(result.status).toBe('success');
    expect(result.untouchedUnpublishedSermonIds).toContain('sermon-12');

    const snapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .orderBy('position')
      .get();
    const orderedIds = snapshot.docs.map((doc) => doc.id);
    const publishedOrderedIds = snapshot.docs
      .map((doc) => ({ id: doc.id, status: doc.data().uploadStatus?.status }))
      .filter((item) => item.status === uploadStatus.UPLOADED)
      .map((item) => item.id);

    expect(publishedOrderedIds.slice(0, 4)).toEqual(['sermon-2', 'sermon-1', 'sermon-3', 'sermon-4']);
    expect(orderedIds).toContain('sermon-12');

    const remotePromotedSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .doc('sermon-12')
      .get();
    expect(remotePromotedSnapshot.data()?.uploadStatus?.status).toBe(uploadStatus.UPLOADED);

    const untouchedUnpublishedSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .doc('sermon-99')
      .get();
    expect(untouchedUnpublishedSnapshot.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
  });

  it('imports unmatched remote media into Firebase during explicit resolution', async () => {
    const fixture = await seedPublishedOverflowFixture();

    subsplashMock.createMediaItem({
      id: 'media-remote',
      title: 'Imported Remote Sermon',
      subtitle: 'Imported Subtitle',
      summary: 'Imported from Subsplash',
      duration: 900,
      audio_url: 'https://subsplash.example/audio.mp3',
      _embedded: {
        images: [
          {
            id: 'subsplash-image-1',
            type: 'square',
            width: 100,
            height: 100,
            _links: {
              self: { href: 'https://subsplash.example/images/1' },
              related: { href: 'https://subsplash.example/images/1/related' },
              download: { href: 'https://subsplash.example/images/1/download' },
            },
          },
        ],
      },
    });

    subsplashMock.listRows.set(fixture.tailSubsplashListId, [
      createMediaRow(fixture.tailSubsplashListId, 'row-9', 'media-9', 1),
      createMediaRow(fixture.tailSubsplashListId, 'row-10', 'media-10', 2),
      createMediaRow(fixture.tailSubsplashListId, 'row-11', 'media-11', 3),
      createMediaRow(fixture.tailSubsplashListId, 'row-12', 'media-12', 4),
      createMediaRow(fixture.tailSubsplashListId, 'row-remote', 'media-remote', 5),
    ]);

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');
    expect(drift.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REMOTE_ONLY_UNMATCHED', mediaItemId: 'media-remote' })])
    );

    const result = await resolvePublishedListDrift({
      listId: fixture.rootFirestoreListId,
      token: 'fake-token',
      strategy: 'FIREBASE_FROM_SUBSPLASH',
    });

    expect(result.importedSermonIds).toHaveLength(1);
    const importedSermonSnapshot = await firestore
      .collection('sermons')
      .doc(result.importedSermonIds[0])
      .get();

    expect(importedSermonSnapshot.exists).toBe(true);
    expect(importedSermonSnapshot.data()).toMatchObject({
      title: 'Imported Remote Sermon',
      subsplashId: 'media-remote',
      audioSource: 'subsplash',
      subsplashAudioUrl: 'https://subsplash.example/audio.mp3',
    });

    const importedProjectionSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .doc(result.importedSermonIds[0])
      .get();
    expect(importedProjectionSnapshot.data()?.uploadStatus?.status).toBe(uploadStatus.UPLOADED);

    const importedImageSnapshot = await firestore.collection('images').where('subsplashId', '==', 'subsplash-image-1').get();
    expect(importedImageSnapshot.empty).toBe(false);
  });

  it('blocks explicit resolution when a remote media item ambiguously matches multiple Firebase sermons', async () => {
    const fixture = await seedPublishedOverflowFixture();

    await createSermonDocument({
      ...buildSermon(500),
      id: 'sermon-duplicate-media-5',
      title: 'Duplicate Media 5',
      subsplashId: 'media-5',
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
    });

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');
    expect(drift.inSync).toBe(false);
    expect(drift.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REMOTE_ONLY_AMBIGUOUS_MATCH',
          mediaItemId: 'media-5',
        }),
      ])
    );

    await expect(
      resolvePublishedListDrift({
        listId: fixture.rootFirestoreListId,
        token: 'fake-token',
        strategy: 'FIREBASE_FROM_SUBSPLASH',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('rebuilds Firebase published projection from Subsplash for a legacy list with no root projection yet', async () => {
    const fixture = await seedPublishedOverflowFixture({
      writeRootProjection: false,
      writeSermonLists: false,
    });

    await createSermonDocument({
      ...buildSermon(99),
      id: 'sermon-99',
      subsplashId: 'media-99',
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PROCESSED,
      },
    });

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');
    expect(drift.inSync).toBe(false);
    expect(drift.localPublishedItems).toHaveLength(0);
    expect(drift.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REMOTE_ONLY_MATCHED', mediaItemId: 'media-1' })])
    );

    const result = await resolvePublishedListDrift({
      listId: fixture.rootFirestoreListId,
      token: 'fake-token',
      strategy: 'FIREBASE_FROM_SUBSPLASH',
    });

    expect(result.status).toBe('success');
    expect(result.importedSermonIds).toEqual([]);
    expect(result.untouchedUnpublishedSermonIds).toEqual([]);

    const rootProjectionSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .orderBy('position')
      .get();
    expect(rootProjectionSnapshot.docs).toHaveLength(13);
    expect(rootProjectionSnapshot.docs[0].id).toBe('sermon-1');
    expect(rootProjectionSnapshot.docs[12].id).toBe('sermon-13');

    const canonicalMembershipSnapshot = await firestore
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(fixture.rootFirestoreListId)
      .get();
    expect(canonicalMembershipSnapshot.exists).toBe(true);
    expect(canonicalMembershipSnapshot.data()?.uploadStatus?.status).toBe(uploadStatus.UPLOADED);

    const unrelatedSermonSnapshot = await firestore.collection('sermons').doc('sermon-99').get();
    expect(unrelatedSermonSnapshot.exists).toBe(true);
    const unrelatedMembershipSnapshot = await firestore
      .collection('sermons')
      .doc('sermon-99')
      .collection('sermonLists')
      .doc(fixture.rootFirestoreListId)
      .get();
    expect(unrelatedMembershipSnapshot.exists).toBe(false);
  });

  it('surfaces chain-structure diagnostics as blocking drift and refuses explicit resolution', async () => {
    const fixture = await seedPublishedOverflowFixture();

    await firestore.collection('lists').doc(fixture.overflowFirestoreListId).set(
      {
        rootListId: 'wrong-root-id',
        overflowDepth: 9,
      },
      { merge: true }
    );

    const drift = await auditPublishedListDrift(fixture.rootFirestoreListId, 'fake-token');

    expect(drift.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CHAIN_STRUCTURE_INVALID',
          severity: 'blocking',
        }),
      ])
    );
    expect(drift.canReorder).toBe(false);
    expect(drift.canOverflowPublish).toBe(false);

    await expect(
      resolvePublishedListDrift({
        listId: fixture.rootFirestoreListId,
        token: 'fake-token',
        strategy: 'FIREBASE_FROM_SUBSPLASH',
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('ignores mismatch without mutating Firebase state', async () => {
    const fixture = await seedPublishedOverflowFixture();

    subsplashMock.listRows.set(fixture.rootSubsplashListId, [
      createMediaRow(fixture.rootSubsplashListId, 'row-2', 'media-2', 1),
      createMediaRow(fixture.rootSubsplashListId, 'row-1', 'media-1', 2),
      createMediaRow(fixture.rootSubsplashListId, 'row-3', 'media-3', 3),
      createMediaRow(fixture.rootSubsplashListId, 'row-4', 'media-4', 4),
      createOverflowRow(fixture.rootSubsplashListId, 'row-link-1', fixture.overflowSubsplashListId, 5),
    ]);

    const beforeSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .orderBy('position')
      .get();

    const result = await resolvePublishedListDrift({
      listId: fixture.rootFirestoreListId,
      token: 'fake-token',
      strategy: 'IGNORE',
    });

    const afterSnapshot = await firestore
      .collection('lists')
      .doc(fixture.rootFirestoreListId)
      .collection('listItems')
      .orderBy('position')
      .get();

    expect(result.status).toBe('ignored');
    expect(afterSnapshot.docs.map((doc) => doc.id)).toEqual(beforeSnapshot.docs.map((doc) => doc.id));
  });
});
