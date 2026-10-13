import firestore, {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type QueryDocumentSnapshot,
} from '../../firebase/firestore';
import { speakerConverter, type ISpeaker } from '../../types/Speaker';
import { listConverter, type List } from '../../types/List';
import { isDiscoverableRootList } from './searchRecords';

export const BROWSE_PAGE_SIZE = 25;
export type BrowsePage<T> = { items: T[]; cursor?: QueryDocumentSnapshot<T>; hasMore: boolean };

export async function browseSpeakers(cursor?: QueryDocumentSnapshot<ISpeaker>): Promise<BrowsePage<ISpeaker>> {
  const snapshot = await getDocs(
    query(
      collection(firestore, 'speakers').withConverter(speakerConverter),
      orderBy('name'),
      limit(BROWSE_PAGE_SIZE),
      ...(cursor ? [startAfter(cursor)] : [])
    )
  );
  return {
    items: snapshot.docs.map((doc) => doc.data()),
    cursor: snapshot.docs.at(-1),
    hasMore: snapshot.size === BROWSE_PAGE_SIZE,
  };
}

export async function browseLists(listType?: string, cursor?: QueryDocumentSnapshot<List>): Promise<BrowsePage<List>> {
  const snapshot = await getDocs(
    query(
      collection(firestore, 'lists').withConverter(listConverter),
      orderBy('updatedAtMillis', 'desc'),
      limit(BROWSE_PAGE_SIZE),
      ...(listType ? [where('type', '==', listType)] : []),
      ...(cursor ? [startAfter(cursor)] : [])
    )
  );
  // Physical overflow nodes are hidden, but still advance the physical cursor.
  // Even an entirely filtered page is bounded and exposes a next-page action.
  return {
    items: snapshot.docs.map((doc) => doc.data()).filter(isDiscoverableRootList),
    cursor: snapshot.docs.at(-1),
    hasMore: snapshot.size === BROWSE_PAGE_SIZE,
  };
}
