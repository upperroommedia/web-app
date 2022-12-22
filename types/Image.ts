export type ImageSizeType = 'square' | 'wide' | 'banner';
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


export type resizeType = { width: number; height: number; sizeType: ImageType['size'] };
export type supportedContentTypes = 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/webp' | 'image/gif';
