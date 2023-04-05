import { FirestoreDataConverter, QueryDocumentSnapshot } from '../firebase/firestore';

export const ImageSizes = ['square', 'wide', 'banner'] as const;
export type ImageSizeType = (typeof ImageSizes)[number];
export type ImageType = {
  id: string;
  size: 'thumbnail' | 'small' | 'medium' | 'large' | 'original' | 'cropped';
  type: ImageSizeType;
  height: number;
  width: number;
  downloadLink: string;
  name: string;
  dateAddedMillis: number;
  subsplashId?: string;
  averageColorHex?: string;
  vibrantColorHex?: string;
};

export const isImageType = (obj: any): obj is ImageType => {
  return obj.id !== undefined && obj.type !== undefined && obj.size !== undefined;
};

export interface AlgoliaImage extends ImageType {
  nbHits?: number;
  _highlightResult?: {
    name: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
  };
}

export const AspectRatio: { [key in ImageSizeType]: number } = {
  square: 1,
  wide: 16 / 9,
  banner: 1920 / 692,
};

export const emptyImage = {
  id: '',
  size: 'thumbnail',
  type: 'square',
  height: 0,
  width: 0,
  downloadLink: '',
  name: '',
  dateAddedMillis: new Date().getTime(),
};

export type resizeType = { width: number; height: number; sizeType: ImageType['size'] };
export type supportedContentTypes = 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/webp' | 'image/gif';

export const speakerConverter: FirestoreDataConverter<ImageType> = {
  toFirestore: (image: ImageType): ImageType => {
    return image;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<ImageType>): ImageType => {
    return { ...emptyImage, ...snapshot.data(), id: snapshot.id };
  },
};
