import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export const OverflowBehavior = ['ERROR', 'CREATENEWLIST', 'REMOVEOLDEST'] as const;
export type OverflowBehaviorType = (typeof OverflowBehavior)[number];
export interface List {
  id: string;
  name: string;
  images: ImageType[];
  overflowBehavior: OverflowBehaviorType;
  count: number;
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
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  overflowBehavior: 'CREATENEWLIST',
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
