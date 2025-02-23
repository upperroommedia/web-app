import { FirestoreDataConverter, QueryDocumentSnapshot } from '../firebase/firestore';
import { ImageType } from './Image';

export interface ISpeaker {
  id: string;
  listId?: string;
  tagId?: string;
  name: string;
  images: ImageType[];
  sermonCount: number;
}

export const emptySpeaker: ISpeaker = {
  id: '',
  name: '',
  sermonCount: 0,
  images: [],
};

export const speakerConverter: FirestoreDataConverter<ISpeaker> = {
  toFirestore: (speaker: ISpeaker): ISpeaker => {
    return speaker;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<ISpeaker>): ISpeaker => {
    return { ...emptySpeaker, ...snapshot.data(), id: snapshot.id };
  },
};
