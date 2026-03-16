/**
 * Helper functions for setting up Firestore in tests
 */

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';

const firestoreDB = firebaseAdmin.firestore();

export interface ListDocumentData {
  id?: string;
  subsplashId: string;
  title: string;
  name?: string;
  overflowBehavior: OverflowBehavior;
  moreSermonsRef?: string;
  count?: number;
  logicalCount?: number;
  hasOverflowPages?: boolean;
  maxListSize?: number;
  images?: unknown[];
  isMoreSermonsList?: boolean;
  isRootList?: boolean;
  rootListId?: string;
  overflowDepth?: number;
}

/**
 * Create a Firestore document for a list
 */
export async function createListDocument(data: ListDocumentData): Promise<string> {
  const listRef = data.id
    ? firestoreDB.collection('lists').doc(data.id)
    : firestoreDB.collection('lists').doc();
  const docData: Record<string, unknown> = {
    id: listRef.id,
    subsplashId: data.subsplashId,
    name: data.name ?? data.title,
    title: data.title,
    overflowBehavior: data.overflowBehavior,
    createdAtMillis: Date.now(),
    updatedAtMillis: Date.now(),
    count: data.count ?? 0,
    images: data.images ?? [],
    isMoreSermonsList: data.isMoreSermonsList ?? false,
  };
  
  // Only include moreSermonsRef if it's defined (Firestore doesn't allow undefined)
  (
    [
      'moreSermonsRef',
      'logicalCount',
      'hasOverflowPages',
      'maxListSize',
      'isRootList',
      'rootListId',
      'overflowDepth',
    ] as const
  ).forEach((field) => {
    if (data[field] !== undefined) {
      docData[field] = data[field];
    }
  });
  
  await listRef.set(docData);
  return listRef.id;
}

/**
 * Clear all Firestore collections
 */
export async function clearFirestore(): Promise<void> {
  const collections = await firestoreDB.listCollections();
  for (const collection of collections) {
    await firestoreDB.recursiveDelete(collection);
  }
}

/**
 * Get a list document by subsplashId
 */
export async function getListBySubsplashId(subsplashId: string) {
  const query = firestoreDB
    .collection('lists')
    .where('subsplashId', '==', subsplashId)
    .limit(1)
    .withConverter(firestoreAdminListConverter);
  
  const snapshot = await query.get();
  if (snapshot.empty) {
    return null;
  }
  return snapshot.docs[0];
}

export async function createSermonDocument(sermon: Sermon): Promise<void> {
  const payload = Object.fromEntries(
    Object.entries({
      ...sermon,
      date: firebaseAdmin.firestore.Timestamp.fromMillis(sermon.dateMillis),
    }).filter(([, value]) => value !== undefined)
  );

  await firestoreDB.collection('sermons').doc(sermon.id).set(payload);
}
