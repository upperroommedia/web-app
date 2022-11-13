import { ImageType } from './Image';

export interface ISpeaker {
  listId?: string;
  tagId?: string;
  name: string;
  images: ImageType[];
}
