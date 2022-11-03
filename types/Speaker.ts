import { sermonImage } from './Sermon';

export interface ISpeaker {
  listId: string;
  name: string;
  images: sermonImage[];
}
