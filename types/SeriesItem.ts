import { FirestoreDataConverter, QueryDocumentSnapshot, Timestamp } from 'firebase/firestore';

/**
 * Firestore SeriesItem document type
 * Stored in subcollection: series/{seriesId}/seriesItems/{sermonId}
 * Tracks the position and publish status of each sermon in a series
 */
export interface SeriesItem {
  id: string;                     // sermonId (Firestore)
  sermonSubsplashId?: string;     // Populated when sermon is published to Subsplash
  position: number;               // Order within the series (1-indexed)
  addedAt: Timestamp | null;
  publishedToSubsplash: boolean;  // Whether this item has been synced to Subsplash series
}

export const emptySeriesItem: SeriesItem = {
  id: '',
  position: 0,
  addedAt: null,
  publishedToSubsplash: false,
};

export const createSeriesItem = (
  sermonId: string,
  position: number,
  sermonSubsplashId?: string
): Omit<SeriesItem, 'addedAt'> & { addedAt: Timestamp | null } => ({
  id: sermonId,
  sermonSubsplashId,
  position,
  addedAt: null, // Will be set by serverTimestamp() when saving
  publishedToSubsplash: false,
});

export const seriesItemConverter: FirestoreDataConverter<SeriesItem> = {
  toFirestore: (item: SeriesItem): SeriesItem => {
    return item;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<SeriesItem>): SeriesItem => {
    return { ...emptySeriesItem, ...snapshot.data(), id: snapshot.id };
  },
};
