import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';
import { Sermon } from './SermonTypes';

export interface Series {
  id: string;
  name: string;
  sermons: Sermon[];
  images: ImageType[];
  subsplashId?: string;
  moreSermonsRef?: string;
  isMoreSermonsList?: boolean;
}

export type SeriesSummary = Omit<Series, 'sermons'>;

export const emptySeriesSummary: SeriesSummary = {
  id: '',
  name: '',
  images: [],
};

export const emptySeries: Series = {
  ...emptySeriesSummary,
  sermons: [],
};

export const seriesSummaryConverter: FirestoreDataConverter<SeriesSummary> = {
  toFirestore: (series: Series): SeriesSummary => {
    const { sermons: _, ...summary } = series;
    return summary;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): SeriesSummary => {
    const { sermons: _, ...summary } = snapshot.data();
    return summary;
  },
};

export const seriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (speaker: Series): Series => {
    return speaker;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return snapshot.data();
  },
};
