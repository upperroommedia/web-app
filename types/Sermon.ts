import {
  Timestamp,
  QueryDocumentSnapshot,
  SnapshotOptions,
} from 'firebase/firestore';

export interface Sermon {
  key: string;
  title: string;
  description: string;
  speaker: Array<string>;
  subtitle: string;
  scripture: string;
  date: Date;
  topic: Array<string>;
}

export const sermonConverter = {
  toFirestore: (sermon: Sermon) => {
    return { ...sermon, date: Timestamp.fromDate(sermon.date) };
  },
  fromFirestore: (
    snapshot: QueryDocumentSnapshot<Sermon>,
    options: SnapshotOptions
  ) => {
    return {
      ...snapshot.data(options),
      // TODO: Fix this type issue
      date: (snapshot.data(options).date as unknown as Timestamp).toDate(),
    };
  },
};

export const emptySermon: Sermon = {
  key: '',
  title: '',
  subtitle: '',
  date: new Date(),
  description: '',
  speaker: [],
  scripture: '',
  topic: [],
};
