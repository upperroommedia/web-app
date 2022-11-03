import { sermonImage } from './SermonTypes';

export interface ISpeaker {
  listId: string;
  name: string;
  objectID: string;
  images: sermonImage[];
}
