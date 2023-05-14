import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';

export interface Topic {
  id: string;
  listId?: string;
  title: string;
  itemsCount: number;
  createdAtMillis: number;
  updatedAtMillis: number;
  images: ImageType[];
}

export const emptyTopic: Topic = {
  id: '',
  title: '',
  itemsCount: 0,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  images: [],
};

export const topicConverter: FirestoreDataConverter<Topic> = {
  toFirestore: (topic: Topic): Topic => {
    return topic;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Topic>): Topic => {
    return { ...emptyTopic, ...snapshot.data(), id: snapshot.id };
  },
};
