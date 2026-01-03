/**
 * Helper functions for setting up Firestore in tests
 */

import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { OverflowBehavior } from '../../../../types/List';

const firestoreDB = firebaseAdmin.firestore();

export interface ListDocumentData {
  subsplashId: string;
  title: string;
  overflowBehavior: OverflowBehavior;
  moreSermonsRef?: string;
  count?: number;
  images?: unknown[];
  isMoreSermonsList?: boolean;
}

/**
 * Create a Firestore document for a list
 */
export async function createListDocument(data: ListDocumentData): Promise<string> {
  const listRef = firestoreDB.collection('lists').doc();
  const docData: Record<string, unknown> = {
    id: listRef.id,
    subsplashId: data.subsplashId,
    title: data.title,
    overflowBehavior: data.overflowBehavior,
    createdAtMillis: Date.now(),
    updatedAtMillis: Date.now(),
    count: data.count ?? 0,
    images: data.images ?? [],
    isMoreSermonsList: data.isMoreSermonsList ?? false,
  };
  
  // Only include moreSermonsRef if it's defined (Firestore doesn't allow undefined)
  if (data.moreSermonsRef !== undefined) {
    docData.moreSermonsRef = data.moreSermonsRef;
  }
  
  await listRef.set(docData);
  return listRef.id;
}

/**
 * Clear all Firestore collections
 */
export async function clearFirestore(): Promise<void> {
  const collections = await firestoreDB.listCollections();
  for (const collection of collections) {
    const snapshot = await collection.get();
    const batch = firestoreDB.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    if (snapshot.docs.length > 0) {
      await batch.commit();
    }
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

