import { ImageType } from './Image';

export interface Series {
  id: string;
  name: string;
  sermonIds: string[];
  images: ImageType[];
}

export const emptySeries: Series = {
  id: '',
  name: '',
  sermonIds: [],
  images: [],
};
