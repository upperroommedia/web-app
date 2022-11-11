import { ImageType } from './Image';

export interface ISpeaker {
  listId: string;
  name: string;
  objectID: string;
  images: ImageType[];
}
