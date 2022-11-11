export type ImageType = {
  id: string;
  size: 'thumbnail' | 'small' | 'medium' | 'large' | 'original' | 'cropped';
  type: 'square' | 'wide' | 'banner';
  height: number;
  width: number;
  downloadLink: string;
  name: string;
  subsplashId?: string;
};

export type ImagesType = {
  images: ImageType[];
  name: string;
  description?: string;
};

export type resizeType = { width: number; height: number; sizeType: ImageType['size'] };
export type supportedContentTypes = 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/webp' | 'image/gif';
