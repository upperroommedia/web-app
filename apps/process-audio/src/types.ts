import type { Timestamp } from 'firebase-admin/firestore';
import { v4 as uuidv4 } from 'uuid';
import type {
  AddIntroOutroInputType as ProcessAudioInputType,
  AudioSource,
  CustomMetadata,
  FilePaths,
  YouTubeUrl,
} from '@upperroom/contracts/addIntroOutro/types';
import type { Sermon as SharedSermon, sermonStatus } from '@upperroom/shared/types/SermonTypes';

export type { ProcessAudioInputType, AudioSource, CustomMetadata, FilePaths, YouTubeUrl, sermonStatus };

export enum sermonStatusType {
  ERROR = 'ERROR',
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
}

export enum uploadStatus {
  ERROR = 'ERROR',
  NOT_UPLOADED = 'NOT_UPLOADED',
  UPLOADED = 'UPLOADED',
}

export type Sermon = SharedSermon;

export interface FirebaseSermon extends Omit<Sermon, 'dateMillis' | 'dateString'> {
  date: Timestamp;
}

export const getDateString = (date: Date) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
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
    createdAtMillis: currentDate.getTime(),
    editedAtMillis: currentDate.getTime(),
  };
};
