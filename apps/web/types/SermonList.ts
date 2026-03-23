import { FirestoreDataConverter, QueryDocumentSnapshot } from '../firebase/firestore';
import { createEmptyList, emptyList, List, ListType } from './List';
import { uploadStatus } from './SermonTypes';

export type listUploadStatus =
  | {
      status: uploadStatus.NOT_UPLOADED;
    }
  | { status: uploadStatus.UPLOADED; listItemId: string }
  | {
      status: uploadStatus.ERROR;
      reason: string;
    };
export interface SermonList extends List {
  uploadStatus?: listUploadStatus;
  publishGeneration?: number;
}

export const emptySermonList: SermonList = {
  ...emptyList,
  uploadStatus: { status: uploadStatus.NOT_UPLOADED },
  publishGeneration: 0,
};

export const createEmptySermonList = (type: ListType): SermonList => {
  return { ...createEmptyList(type), uploadStatus: { status: uploadStatus.NOT_UPLOADED }, publishGeneration: 0 };
};

export const sermonListConverter: FirestoreDataConverter<SermonList> = {
  toFirestore: (list: SermonList): SermonList => {
    return Object.fromEntries(
      Object.entries(list).filter(([, value]) => value !== undefined)
    ) as SermonList;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<SermonList>): SermonList => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};
