import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export const OverflowBehavior = ['ERROR', 'CREATENEWLIST', 'REMOVEOLDEST'] as const;
export type OverflowBehaviorType = (typeof OverflowBehavior)[number];
export interface Series {
  id: string;
  name: string;
  images: ImageType[];
  overflowBehavior: OverflowBehaviorType;
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
  overflowBehavior: 'CREATENEWLIST',
  images: [],
};

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return snapshot.data();
  },
};
