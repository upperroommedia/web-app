import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export interface Series {
  id: string;
  name: string;
  sermonIds: string[];
  images: ImageType[];
  subsplashId?: string;
  moreSermonsRef?: string;
}

export const emptySeries: Series = {
  id: '',
  name: '',
  sermonIds: [],
  images: [],
};

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (speaker: Series): Series => {
    return speaker;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return snapshot.data();
  },
};
