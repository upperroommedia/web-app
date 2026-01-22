import { FirestoreDataConverter, QueryDocumentSnapshot, Timestamp } from 'firebase/firestore';
import { ImageType } from './Image';

/**
 * Firestore Series document type
 * Represents a media series in our Firebase database
 * Distinct from List - series have a 1:1 relationship with media items
 */
export interface Series {
  id: string;
  name: string;
  subtitle?: string;
  summary?: string;
  images: ImageType[];
  itemCount: number;
  publishedItemCount: number;
  status: 'draft' | 'published';
  subsplashId: string;
  slug?: string;
  shortCode?: string;
  position?: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export const emptySeries: Series = {
  id: '',
  name: '',
  images: [],
  itemCount: 0,
  publishedItemCount: 0,
  status: 'draft',
  subsplashId: '',
  createdAt: null,
  updatedAt: null,
};

export const createEmptySeries = (): Series => ({
  ...emptySeries,
});

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return { ...emptySeries, ...snapshot.data(), id: snapshot.id };
  },
};
