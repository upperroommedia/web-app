/**
 * Helper functions for setting up Firestore Series documents in tests
 */

import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminSeriesConverter } from '../../firestoreDataConverter';
import { Series } from '../../../../types/Series';

const firestoreDB = firebaseAdmin.firestore();
// Use FieldValue from the same firebaseAdmin instance to ensure proper serialization
const FieldValue = firebaseAdmin.firestore.FieldValue;

export interface SeriesDocumentData {
  subsplashId: string;
  name: string;
  subtitle?: string;
  summary?: string;
  itemCount?: number;
  publishedItemCount?: number;
  status?: 'draft' | 'published';
  slug?: string;
  shortCode?: string;
  position?: number;
  images?: unknown[];
}

/**
 * Create a Firestore document for a series
 * Uses FieldValue.serverTimestamp() for proper server-side timestamps
 */
export async function createSeriesDocument(data: SeriesDocumentData): Promise<string> {
  const seriesRef = firestoreDB.collection('series').doc();
  
  // Build base data without timestamps first
  const baseData: Record<string, unknown> = {
    id: seriesRef.id,
    subsplashId: data.subsplashId,
    name: data.name,
    subtitle: data.subtitle,
    summary: data.summary,
    itemCount: data.itemCount ?? 0,
    publishedItemCount: data.publishedItemCount ?? 0,
    status: data.status ?? 'draft',
    slug: data.slug,
    shortCode: data.shortCode,
    position: data.position,
    images: data.images ?? [],
  };

  // Remove undefined values BEFORE adding FieldValue sentinels
  // (iterating after adding FieldValue corrupts the sentinel)
  Object.keys(baseData).forEach((key) => {
    if (baseData[key] === undefined) {
      delete baseData[key];
    }
  });

  // Add server timestamps after filtering
  await seriesRef.set({
    ...baseData,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  
  return seriesRef.id;
}

/**
 * Get a series document by subsplashId
 */
export async function getSeriesBySubsplashId(subsplashId: string): Promise<Series | null> {
  const query = firestoreDB
    .collection('series')
    .where('subsplashId', '==', subsplashId)
    .limit(1)
    .withConverter(firestoreAdminSeriesConverter);

  const snapshot = await query.get();
  if (snapshot.empty) {
    return null;
  }
  return snapshot.docs[0].data();
}

/**
 * Get a series document by Firestore ID
 */
export async function getSeriesById(firestoreId: string): Promise<Series | null> {
  const docRef = firestoreDB
    .collection('series')
    .doc(firestoreId)
    .withConverter(firestoreAdminSeriesConverter);

  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    return null;
  }
  return snapshot.data() || null;
}

/**
 * Update a series document
 */
export async function updateSeriesDocument(
  firestoreId: string,
  updates: Partial<SeriesDocumentData>
): Promise<void> {
  const docRef = firestoreDB.collection('series').doc(firestoreId);
  
  // Build base update data without timestamp
  const baseData: Record<string, unknown> = { ...updates };

  // Remove undefined values BEFORE adding FieldValue sentinel
  Object.keys(baseData).forEach((key) => {
    if (baseData[key] === undefined) {
      delete baseData[key];
    }
  });

  // Add server timestamp after filtering
  await docRef.update({
    ...baseData,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Delete a series document
 */
export async function deleteSeriesDocument(firestoreId: string): Promise<void> {
  const docRef = firestoreDB.collection('series').doc(firestoreId);
  await docRef.delete();
}

/**
 * Clear all documents from the series collection
 */
export async function clearSeriesCollection(): Promise<void> {
  const snapshot = await firestoreDB.collection('series').get();
  const batch = firestoreDB.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  if (snapshot.docs.length > 0) {
    await batch.commit();
  }
}

/**
 * Clear all Firestore collections (for complete test isolation)
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
 * Get all series documents
 */
export async function getAllSeries(): Promise<Series[]> {
  const snapshot = await firestoreDB
    .collection('series')
    .withConverter(firestoreAdminSeriesConverter)
    .get();
  return snapshot.docs.map((doc) => doc.data());
}
