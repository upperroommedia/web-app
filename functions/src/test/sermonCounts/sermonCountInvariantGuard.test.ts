import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { ensureSermonCountInvariant } from '../../utils/sermonCountInvariantGuard';

const firestoreDb = firebaseAdmin.firestore();

async function clearFirestore(): Promise<void> {
  const collections = await firestoreDb.listCollections();
  for (const collectionRef of collections) {
    const snapshot = await collectionRef.get();
    if (snapshot.empty) {
      continue;
    }

    const batch = firestoreDb.batch();
    snapshot.docs.forEach((docRef) => {
      batch.delete(docRef.ref);
    });
    await batch.commit();
  }
}

async function seedSermon(
  sermonId: string,
  numberOfLists: number,
  numberOfListsUploadedTo: number
): Promise<void> {
  const now = Date.now();
  await firestoreDb
    .collection('sermons')
    .doc(sermonId)
    .set({
      id: sermonId,
      title: `sermon-${sermonId}`,
      subtitle: '',
      description: '',
      date: firebaseAdmin.firestore.Timestamp.now(),
      dateMillis: now,
      sourceStartTime: 0,
      durationSeconds: 0,
      speakers: [],
      topics: [],
      status: {
        subsplash: uploadStatus.NOT_UPLOADED,
        soundCloud: uploadStatus.NOT_UPLOADED,
        audioStatus: sermonStatusType.PENDING,
      },
      images: [],
      numberOfLists,
      numberOfListsUploadedTo,
      createdAtMillis: now,
      editedAtMillis: now,
    });
}

async function seedSermonLists(sermonId: string, statuses: uploadStatus[]): Promise<void> {
  const writes = statuses.map((status, index) => {
    const base = firestoreDb.collection('sermons').doc(sermonId).collection('sermonLists').doc(`list-${index}`);
    if (status === uploadStatus.UPLOADED) {
      return base.set({
        uploadStatus: {
          status,
          listItemId: `item-${index}`,
        },
      });
    }

    return base.set({
      uploadStatus: {
        status,
      },
    });
  });

  await Promise.all(writes);
}

describe('ensureSermonCountInvariant', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('does not rewrite counters when invariant is valid', async () => {
    const sermonId = 'valid-invariant-sermon';
    await seedSermon(sermonId, 2, 1);
    await seedSermonLists(sermonId, [uploadStatus.UPLOADED, uploadStatus.NOT_UPLOADED]);

    const result = await ensureSermonCountInvariant(sermonId);

    expect(result.repaired).toBe(false);
    const sermonSnapshot = await firestoreDb.collection('sermons').doc(sermonId).get();
    expect(sermonSnapshot.data()?.numberOfLists).toBe(2);
    expect(sermonSnapshot.data()?.numberOfListsUploadedTo).toBe(1);
  });

  it('recalculates from sermonLists truth when uploaded exceeds total', async () => {
    const sermonId = 'uploaded-greater-than-total';
    await seedSermon(sermonId, 1, 4);
    await seedSermonLists(sermonId, [uploadStatus.UPLOADED, uploadStatus.UPLOADED, uploadStatus.NOT_UPLOADED]);

    const result = await ensureSermonCountInvariant(sermonId);

    expect(result.repaired).toBe(true);
    const sermonSnapshot = await firestoreDb.collection('sermons').doc(sermonId).get();
    expect(sermonSnapshot.data()?.numberOfLists).toBe(3);
    expect(sermonSnapshot.data()?.numberOfListsUploadedTo).toBe(2);
  });

  it('recalculates and persists non-negative counters when values are negative', async () => {
    const sermonId = 'negative-counters';
    await seedSermon(sermonId, -3, -1);
    await seedSermonLists(sermonId, [uploadStatus.UPLOADED, uploadStatus.NOT_UPLOADED]);

    const result = await ensureSermonCountInvariant(sermonId);

    expect(result.repaired).toBe(true);
    const sermonSnapshot = await firestoreDb.collection('sermons').doc(sermonId).get();
    expect(sermonSnapshot.data()?.numberOfLists).toBe(2);
    expect(sermonSnapshot.data()?.numberOfListsUploadedTo).toBe(1);
    expect(sermonSnapshot.data()?.numberOfLists).toBeGreaterThanOrEqual(0);
    expect(sermonSnapshot.data()?.numberOfListsUploadedTo).toBeGreaterThanOrEqual(0);
  });
});
