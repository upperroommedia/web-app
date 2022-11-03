import { sermonImage } from './SermonTypes';

export interface ISpeaker {
  listId: string;
  name: string;
  images: sermonImage[];
}
