interface ImageMetadata {
  width: number;
  height: number;
  averageColorHex: string;
  vibrantColorHex: string;
}

const computeMetadataForImage = async (url: string, dimensionsOnly = false): Promise<ImageMetadata> => {
  // TODO[0]: Implement this function
  if (dimensionsOnly) {
    return { width: 100, height: 100, averageColorHex: '', vibrantColorHex: '' };
  }
  return { width: 100, height: 100, averageColorHex: '#9fccb9', vibrantColorHex: '#2b7256' };
};

export default computeMetadataForImage;
