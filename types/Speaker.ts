import { ImageType } from './Image';

export interface ISpeaker {
  id: string;
  listId?: string;
  tagId?: string;
  name: string;
  images: ImageType[];
  sermonCount: number;
  _highlightResult?: {
    name: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
  };
}
