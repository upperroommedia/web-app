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

export enum ListTag {
  BIBLE_CHAPTER = 'bible-chapter',
  SUNDAY_HOMILY_MONTH = 'sunday-homily-month',
}

export type ListTagAndPostionType =
  | {
      listTag: ListTag.BIBLE_CHAPTER;
      position: number;
    }
  | {
      listTag: ListTag.SUNDAY_HOMILY_MONTH;
      position: number;
      year: number;
    };

export interface List {
  id: string;
  name: string;
  images: ImageType[];
  overflowBehavior: OverflowBehavior;
  count?: number;
  logicalCount?: number;
  hasOverflowPages?: boolean;
  type: ListType;
  updatedAtMillis?: number;
  createdAtMillis: number;
  subsplashId?: string;
  moreSermonsRef?: string;
  isMoreSermonsList?: boolean;
  isRootList?: boolean;
  rootListId?: string;
  overflowDepth?: number;
  listTagAndPosition?: ListTagAndPostionType;
}

export interface SundayHomiliesMonthList extends List {
  listTagAndPosition: Extract<ListTagAndPostionType, { listTag: ListTag.SUNDAY_HOMILY_MONTH }>;
}

export interface BibleStudyList extends List {
  listTagAndPosition: Extract<ListTagAndPostionType, { listTag: ListTag.BIBLE_CHAPTER }>;
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
  logicalCount: 0,
  hasOverflowPages: false,
  type: ListType.SERIES,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  overflowBehavior: OverflowBehavior.CREATENEWLIST,
  images: [],
  isRootList: true,
  rootListId: '',
  overflowDepth: 0,
};

export const createEmptyList = (type: ListType): List => {
  return {
    id: '',
    name: '',
    count: 0,
    logicalCount: 0,
    hasOverflowPages: false,
    type,
    createdAtMillis: new Date().getTime(),
    updatedAtMillis: new Date().getTime(),
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    images: [],
    isRootList: true,
    rootListId: '',
    overflowDepth: 0,
  };
};

export const listConverter: FirestoreDataConverter<List> = {
  toFirestore: (list: List): List => {
    return list;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<List>): List => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};
