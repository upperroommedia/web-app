import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';
import { Sermon } from './SermonTypes';

export const OverflowBehavior = ['ERROR', 'CREATENEWLIST', 'REMOVEOLDEST'] as const;
export type OverflowBehaviorType = (typeof OverflowBehavior)[number];
export interface Series {
  id: string;
  name: string;
  sermonsInSubsplash: Sermon[];
  allSermons: Sermon[];
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

export type SeriesSummary = Omit<Series, 'allSermons' | 'sermonsInSubsplash'>;

export const emptySeriesSummary: SeriesSummary = {
  id: '',
  name: '',
  overflowBehavior: 'CREATENEWLIST',
  images: [],
};

export const emptySeries: Series = {
  ...emptySeriesSummary,
  sermonsInSubsplash: [],
  allSermons: [],
};

export const seriesSummaryConverter: FirestoreDataConverter<SeriesSummary> = {
  toFirestore: (series: Series): SeriesSummary => {
    const { sermonsInSubsplash: _, allSermons: _allSermons, ...summary } = series;
    return summary;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): SeriesSummary => {
    const { sermonsInSubsplash: _, allSermons: _allSermons, ...summary } = snapshot.data();
    return summary;
  },
};

export const convertSeriesToSeriesSummary = (series: Series): SeriesSummary => {
  const { sermonsInSubsplash: _, allSermons: _allSermons, ...summary } = series;
  return summary;
};

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return snapshot.data();
  },
};
