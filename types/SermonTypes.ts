import { ImageType } from './Image';
import { ISpeaker } from './Speaker';

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
  images: ImageType[];
}
