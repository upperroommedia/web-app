import { Timestamp, QueryDocumentSnapshot, FirestoreDataConverter } from '../firebase/firestore';
import { ISpeaker } from './Speaker';
import { v4 as uuidv4 } from 'uuid';

export enum sermonStatusType {
  ERROR = 'ERROR',
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  UPLOADED = 'UPLOADED',
}

export interface sermonStatus {
  type: sermonStatusType;
  message?: string;
}

export type sermonImage = {
  id: string;
  type: 'square' | 'wide' | 'banner';
  height: number;
  width: number;
  downloadLink: string;
  title: string;
};

export interface Sermon {
  key: string;
  title: string;
  description: string;
  series: string;
  speakers: ISpeaker[];
  subtitle: string;
  scripture: string;
  dateMillis: number;
  durationSeconds: number;
  topics: string[];
  dateString?: string;
  status: sermonStatus;
  images: sermonImage[];
}

export const createSermon = ({
  key = uuidv4(),
  title = '',
  subtitle = '',
  series = '',
  description = '',
  dateMillis = 0,
  durationSeconds = 0,
  speakers = <ISpeaker[]>[],
  scripture = '',
  topics = <string[]>[],
  dateString = new Date().toLocaleDateString(),
  status = { type: sermonStatusType.PENDING },
  images = <sermonImage[]>[],
}): Sermon => {
  return {
    key,
    title,
    subtitle,
    series,
    description,
    dateMillis,
    durationSeconds,
    speakers,
    scripture,
    topics,
    dateString,
    status,
    images,
  };
};

export interface FirebaseSermon extends Omit<Sermon, 'dateMillis' | 'dateString'> {
  date: Timestamp;
}

export const getDateString = (date: Date) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
};

/* This converter takes care of converting a Sermon to a FirebaseSermon on upload
 *  and a FirebaseSermon to a Sermon on download.
 */
export const sermonConverter: FirestoreDataConverter<Sermon> = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return { ...sermon, date: Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { date, ...data } = snapshot.data();

    return {
      ...data,
      dateMillis: snapshot.data().date.toMillis(),
      dateString: getDateString(snapshot.data().date.toDate()),
    };
  },
};

export const emptySermon: Sermon = {
  key: uuidv4(),
  title: '',
  subtitle: '',
  series: '',
  description: '',
  dateMillis: 0,
  durationSeconds: 0,
  speakers: [],
  scripture: '',
  topics: [],
  dateString: new Date().toLocaleDateString(),
  status: { type: sermonStatusType.PENDING },
  images: [],
};
