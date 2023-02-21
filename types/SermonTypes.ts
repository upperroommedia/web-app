import { ImageType } from './Image';
import { Series } from './Series';
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
  key: string;
  title: string;
  description: string;
  series: Series;
  speakers: ISpeaker[];
  subtitle: string;
  dateMillis: number;
  durationSeconds: number;
  topics: string[];
  dateString?: string;
  status: sermonStatus;
  images: ImageType[];
  subsplashId?: string;
  soundCloudTrackId?: string;
}
