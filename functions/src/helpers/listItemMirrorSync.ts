import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { uploadStatus, type Sermon } from '@upperroom/shared/types/SermonTypes';
import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import type { SubsplashListRow } from '../types/Subsplash';

const firestore = firebaseAdmin.firestore();

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const getContentRows = (rows: SubsplashListRow[]): SubsplashListRow[] =>
  rows.filter((row) => row.type === 'media-item' && row._embedded['media-item']?.id);

const getRowsBySubsplashMediaId = (rows: SubsplashListRow[]): Map<string, SubsplashListRow> => {
  return new Map(
    getContentRows(rows).map((row) => [row._embedded['media-item']!.id, row] as const)
  );
};

const getLocalSermonsBySubsplashId = async (subsplashMediaIds: string[]): Promise<Map<string, Sermon>> => {
  const sermonsBySubsplashId = new Map<string, Sermon>();

  for (const subsplashIdChunk of chunk([...new Set(subsplashMediaIds)], 10)) {
    if (subsplashIdChunk.length === 0) {
      continue;
    }

    const snapshot = await firestore
      .collection('sermons')
      .where('subsplashId', 'in', subsplashIdChunk)
      .withConverter(firestoreAdminSermonConverter)
      .get();

    snapshot.docs.forEach((doc) => {
      const sermon = doc.data();
      if (sermon.subsplashId) {
        sermonsBySubsplashId.set(sermon.subsplashId, sermon);
      }
    });
  }

  return sermonsBySubsplashId;
};

export const syncListItemMirrorByFirestoreListId = async (
  firestoreListId: string,
  rows: SubsplashListRow[]
): Promise<void> => {
  const rowsBySubsplashMediaId = getRowsBySubsplashMediaId(rows);
  const subsplashMediaIds = [...rowsBySubsplashMediaId.keys()];
  const sermonsBySubsplashId = await getLocalSermonsBySubsplashId(subsplashMediaIds);
  const desiredBySermonId = new Map<string, { sermon: Sermon; row: SubsplashListRow }>();

  rowsBySubsplashMediaId.forEach((row, subsplashMediaId) => {
    const sermon = sermonsBySubsplashId.get(subsplashMediaId);
    if (!sermon) {
      return;
    }

    desiredBySermonId.set(sermon.id, { sermon, row });
  });

  const listItemsRef = firestore.collection('lists').doc(firestoreListId).collection('listItems');
  const batch = firestore.batch();
  let writes = 0;

  desiredBySermonId.forEach(({ sermon, row }, sermonId) => {
    batch.set(
      listItemsRef.doc(sermonId),
      {
        ...sermon,
        position: row.position,
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: row.id,
        },
      },
      { merge: true }
    );
    writes += 1;
  });

  if (writes > 0) {
    await batch.commit();
  }
};

export const syncListItemMirrorBySubsplashListId = async (
  subsplashListId: string,
  rows: SubsplashListRow[]
): Promise<void> => {
  const listSnapshot = await firestore.collection('lists').where('subsplashId', '==', subsplashListId).limit(1).get();
  if (listSnapshot.empty) {
    return;
  }

  await syncListItemMirrorByFirestoreListId(listSnapshot.docs[0].id, rows);
};
