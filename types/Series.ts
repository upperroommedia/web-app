import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export interface Series {
  id: string;
  name: string;
  images: ImageType[];
  count: number;
  subsplashId?: string;
  moreSermonsRef?: string;
  isMoreSermonsList?: boolean;
}

export interface SeriesWithHighlight extends Series {
  _highlightResult?: {
    name: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
  };
}

export const emptySeries: Series = {
  id: '',
  name: '',
  count: 0,
  images: [],
};

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return { ...emptySeries, ...snapshot.data(), id: snapshot.id };
  },
};
