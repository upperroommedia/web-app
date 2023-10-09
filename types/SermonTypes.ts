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
  durationSeconds: number;
  topics: string[];
  dateString?: string;
  status: sermonStatus;
  images: ImageType[];
  numberOfLists: number;
  numberOfListsUploadedTo: number;
  subsplashId?: string;
  soundCloudTrackId?: string;
  uploaderId?: string;
  approverId?: string;
  createdAtMillis: number;
  editedAtMillis: number;
}
