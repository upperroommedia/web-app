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
}

export const emptySermonList: SermonList = { ...emptyList, uploadStatus: { status: uploadStatus.NOT_UPLOADED } };

export const createEmptySermonList = (type: ListType): SermonList => {
  return { ...createEmptyList(type), uploadStatus: { status: uploadStatus.NOT_UPLOADED } };
};

export const sermonListConverter: FirestoreDataConverter<SermonList> = {
  toFirestore: (list: SermonList): SermonList => {
    return list;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<SermonList>): SermonList => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};
