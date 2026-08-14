import firestore, {
  collection,
  getDocs,
  orderBy,
  query,
  writeBatch,
} from '../firebase/firestore';

export interface LocalSeriesItemPosition {
  id: string;
  position: number;
}

const MAX_POSITION_WRITES_PER_BATCH = 400;

export function chunkSeriesItemPositionUpdates<T>(updates: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < updates.length; index += MAX_POSITION_WRITES_PER_BATCH) {
    chunks.push(updates.slice(index, index + MAX_POSITION_WRITES_PER_BATCH));
  }
  return chunks;
}

export function planCompactedSeriesItemPositions(
  items: LocalSeriesItemPosition[]
): LocalSeriesItemPosition[] {
  return [...items]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((item, index) => ({ id: item.id, position: index + 1 }))
    .filter((item) => item.position !== items.find((source) => source.id === item.id)?.position);
}

export async function compactSeriesItemPositions(firestoreSeriesId: string): Promise<void> {
  const seriesItems = await getDocs(
    query(
      collection(firestore, `series/${firestoreSeriesId}/seriesItems`),
      orderBy('position', 'asc')
    )
  );
  const updates = planCompactedSeriesItemPositions(
    seriesItems.docs.map((document) => ({
      id: document.id,
      position: Number(document.data().position) || 0,
    }))
  );
  if (updates.length === 0) {
    return;
  }

  const documentsById = new Map(seriesItems.docs.map((document) => [document.id, document]));
  for (const chunk of chunkSeriesItemPositionUpdates(updates)) {
    const batch = writeBatch(firestore);
    chunk.forEach((update) => {
      batch.update(documentsById.get(update.id)!.ref, { position: update.position });
    });
    await batch.commit();
  }
}
