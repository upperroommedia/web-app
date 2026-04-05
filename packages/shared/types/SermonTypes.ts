import { ImageType } from './Image';
import { ISpeaker } from './Speaker';

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

export type publishActivityOperation = 'idle' | 'publish' | 'unpublish';

export interface sermonPublishActivity {
  listOperation: publishActivityOperation;
  listIds: string[];
  seriesOperation: publishActivityOperation;
  soundCloudOperation: publishActivityOperation;
  updatedAtMillis?: number;
}

export interface sermonStatus {
  subsplash: uploadStatus;
  soundCloud: uploadStatus;
  audioStatus: sermonStatusType;
  message?: string;
}

export interface Sermon {
  id: string;
  title: string;
  description: string;
  speakers: ISpeaker[];
  subtitle: string;
  dateMillis: number;
  sourceStartTime: number;
  trimDurationSeconds?: number;
  durationSeconds: number;
  topics: string[];
  dateString?: string;
  status: sermonStatus;
  images: ImageType[];
  numberOfLists?: number;
  numberOfListsUploadedTo?: number;
  subsplashId?: string;
  audioSource?: 'gcp' | 'subsplash';
  subsplashAudioUrl?: string;
  soundCloudTrackId?: string;
  soundCloudTrackUrl?: string;
  uploaderId?: string;
  approverId?: string;
  createdAtMillis: number;
  editedAtMillis: number;
  youtubeUrl?: string;
  seriesId?: string;  // Firestore series ID (not subsplashId) - sermon can only be in one series
  publishActivity?: sermonPublishActivity;
}
