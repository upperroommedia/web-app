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
  dateMillis: number;
  duration: number;
  currentPlayTime: number;
  topic: Array<string>;
  dateString?: string;
}

export interface FirebaseSermon
  extends Omit<Sermon, 'dateMillis' | 'dateString'> {
  date: Timestamp;
}

/* This converter takes care of converting a Sermon to a FirebaseSermon on upload
 *  and a FirebaseSermon to a Sermon on download.
 */
export const sermonConverter = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return { ...sermon, date: Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (
    snapshot: QueryDocumentSnapshot<FirebaseSermon>,
    options: SnapshotOptions
  ): Sermon => {
    const { date, ...data } = snapshot.data(options);
    return {
      ...data,
      dateMillis: snapshot.data(options).date.toMillis(),
      dateString: snapshot.data(options).date.toDate().toDateString(),
    };
  },
};

export const emptySermon: Sermon = {
  key: '',
  title: '',
  subtitle: '',
  dateMillis: 0,
  duration: 0,
  currentPlayTime: 0,
  description: '',
  speaker: [],
  scripture: '',
  topic: [],
  dateString: undefined,
};
