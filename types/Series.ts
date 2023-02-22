import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';

export interface Series {
  id: string;
  name: string;
  sermonIds: string[];
}

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (speaker: Series): Series => {
    return speaker;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return snapshot.data();
  },
};
