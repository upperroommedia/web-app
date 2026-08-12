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

type FirestoreDateLike = {
  toMillis?: () => number;
  seconds?: number;
  nanoseconds?: number;
  _seconds?: number;
  _nanoseconds?: number;
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Firestore normally hydrates `date` as a Timestamp, but legacy list-item
 * mirrors can contain an older scalar or a JSON-serialized Timestamp. Keep a
 * malformed mirror from taking down the entire list details page.
 */
export const getSermonDateMillis = (value: unknown, fallbackMillis: number): number => {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : fallbackMillis;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallbackMillis;
  }

  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : fallbackMillis;
  }

  if (typeof value !== 'object' || value === null) {
    return fallbackMillis;
  }

  const dateLike = value as FirestoreDateLike;
  if (typeof dateLike.toMillis === 'function') {
    try {
      const millis = dateLike.toMillis();
      if (Number.isFinite(millis)) {
        return millis;
      }
    } catch {
      // Fall through to serialized Timestamp fields.
    }
  }

  const seconds = finiteNumber(dateLike.seconds) ?? finiteNumber(dateLike._seconds);
  if (seconds !== null) {
    const nanoseconds = finiteNumber(dateLike.nanoseconds) ?? finiteNumber(dateLike._nanoseconds) ?? 0;
    return seconds * 1_000 + nanoseconds / 1_000_000;
  }

  return fallbackMillis;
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
    const { date, ...data } = snapshot.data();
    const currentTime = Timestamp.now();
    const legacyDateMillis = (data as Partial<Sermon>).dateMillis;
    const fallbackMillis =
      typeof legacyDateMillis === 'number' && Number.isFinite(legacyDateMillis)
        ? legacyDateMillis
        : currentTime.toMillis();
    const dateMillis = getSermonDateMillis(date, fallbackMillis);
    const convertedSermon: Sermon = {
      ...createEmptySermon(),
      ...data,
      ...(date && {
        dateMillis,
        dateString: getDateString(new Date(dateMillis)),
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
