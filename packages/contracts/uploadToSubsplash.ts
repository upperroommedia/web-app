import { ImageType } from '@upperroom/shared/types/Image';
import { ISpeaker } from '@upperroom/shared/types/Speaker';

export interface UPLOAD_TO_SUBSPLASH_INCOMING_DATA {
  operationKey: string;
  lockKey: string;
  title: string;
  subtitle: string;
  speakers: ISpeaker[];
  autoPublish: boolean;
  audioTitle: string;
  audioUrl: string;
  topics?: string[];
  description?: string;
  images: ImageType[];
  date: Date;
}
