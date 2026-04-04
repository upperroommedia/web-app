import { Timestamp, QueryDocumentSnapshot, FirestoreDataConverter } from '../firebase/firestore';
import { ISpeaker } from './Speaker';
import { v4 as uuidv4 } from 'uuid';
import { Sermon, sermonStatusType, uploadStatus } from './SermonTypes';
import { ImageType } from './Image';

export const createSermon = ({
  id = uuidv4(),
  title = '',
  subtitle = '',
  description = '',
  dateMillis = 0,
  sourceStartTime = 0,
  trimDurationSeconds = 0,
  durationSeconds = 0,
  speakers = [] as ISpeaker[],
  topics = [] as string[],
  dateString = new Date().toLocaleDateString(),
  status = {
    soundCloud: uploadStatus.NOT_UPLOADED,
    subsplash: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PENDING,
  },
  images = [] as ImageType[],
  numberOfLists = 0,
  numberOfListsUploadedTo = 0,
  subsplashUploadGeneration = 0,
  createdAtMillis = new Date().getTime(),
  editedAtMillis = new Date().getTime(),
  searchPending = false,
  searchIndexedAtMillis,
  searchSyncError,
  uploaderDisplayName,
  uploaderEmail,
  seriesName,
  seriesImage,
  seriesPublishedToSubsplash,
}: Partial<Sermon> = {}): Sermon => {
  return {
    id,
    title,
    subtitle,
    description,
    dateMillis,
    sourceStartTime,
    trimDurationSeconds,
    durationSeconds,
    speakers,
    topics,
    dateString,
    status,
    images,
    numberOfLists,
    numberOfListsUploadedTo,
    subsplashUploadGeneration,
    createdAtMillis,
    editedAtMillis,
    searchPending,
    searchIndexedAtMillis,
    searchSyncError,
    uploaderDisplayName,
    uploaderEmail,
    seriesName,
    seriesImage,
    seriesPublishedToSubsplash,
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
    // Filter out undefined values to prevent Firebase errors
    // (Firestore doesn't accept undefined, only null or omitted fields)
    const cleanedSermon = Object.fromEntries(
      Object.entries(sermon).filter(([, value]) => value !== undefined)
    ) as Sermon;
    return { ...cleanedSermon, date: Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { date, ...data } = snapshot.data();
    const currentTime = Timestamp.now();
    const convertedSermon: Sermon = {
      ...createEmptySermon(),
      ...data,
      ...(snapshot.data().date && {
        dateMillis: snapshot.data()?.date?.toMillis() || currentTime.toMillis(),
        dateString: getDateString(snapshot.data()?.date?.toDate() || currentTime.toDate()),
      }),
      id: snapshot.id,
    };
    if (!Object.prototype.hasOwnProperty.call(data, 'trimDurationSeconds')) {
      delete convertedSermon.trimDurationSeconds;
    }
    return convertedSermon;
  },
};

export const createEmptySermon = (uploaderId?: string): Sermon => {
  const currentDate = new Date();
  return {
    id: uuidv4(),
    title: '',
    subtitle: '',
    description: '',
    dateMillis: currentDate.getTime(),
    sourceStartTime: 0,
    trimDurationSeconds: 0,
    durationSeconds: 0,
    speakers: [],
    topics: [],
    dateString: currentDate.toLocaleDateString(),
    status: {
      soundCloud: uploadStatus.NOT_UPLOADED,
      subsplash: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PENDING,
    },
    images: [],
    ...(uploaderId && { uploaderId }),
    numberOfLists: 0,
    numberOfListsUploadedTo: 0,
    subsplashUploadGeneration: 0,
    createdAtMillis: currentDate.getTime(),
    editedAtMillis: currentDate.getTime(),
  };
};
