import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export enum OverflowBehavior {
  ERROR = 'ERROR',
  CREATENEWLIST = 'CREATENEWLIST',
  REMOVEOLDEST = 'REMOVEOLDEST',
}
export enum ListType {
  SERIES = 'series',
  SPEAKER_LIST = 'speaker-list',
  TOPIC_LIST = 'topic-list',
  CATEGORY_LIST = 'category-list',
  LATEST = 'latest',
}

export interface List {
  id: string;
  name: string;
  images: ImageType[];
  overflowBehavior: OverflowBehavior;
  count: number;
  type: ListType;
  updatedAtMillis: number;
  createdAtMillis: number;
  subsplashId?: string;
  moreSermonsRef?: string;
  isMoreSermonsList?: boolean;
}

export interface ListWithHighlight extends List {
  _highlightResult?: {
    name: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
  };
}

export const emptyList: List = {
  id: '',
  name: '',
  count: 0,
  type: ListType.SERIES,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  overflowBehavior: OverflowBehavior.CREATENEWLIST,
  images: [],
};

export const listConverter: FirestoreDataConverter<List> = {
  toFirestore: (list: List): List => {
    return list;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<List>): List => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};