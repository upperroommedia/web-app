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

export const AspectRatio: { [key in ImageSizeType]: number } = {
  square: 1,
  wide: 16 / 9,
  banner: 1920 / 692,
};

export type resizeType = { width: number; height: number; sizeType: ImageType['size'] };
export type supportedContentTypes = 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/webp' | 'image/gif';
