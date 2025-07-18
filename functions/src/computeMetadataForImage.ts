import { getAverageColor } from 'fast-average-color-node';
import { Vibrant } from 'node-vibrant/node';
import { logger } from 'firebase-functions';
import sizeOf from 'buffer-image-size';
import axios from 'axios';

interface ImageMetadata {
  width: number;
  height: number;
  averageColorHex: string;
  vibrantColorHex: string;
}
const computeMetadataForImage = async (url: string, dimensionsOnly = false): Promise<ImageMetadata> => {
  let buffer: Buffer | undefined;
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    buffer = Buffer.from(response.data, 'binary');
  } catch (error) {
    logger.error('Error fetching image:', error);
    throw new Error('Failed to fetch image from URL');
  }
  const { width, height } = sizeOf(buffer);
  if (dimensionsOnly) {
    return { width, height, averageColorHex: '', vibrantColorHex: '' };
  }
  let averageColorHex = '#9fccb9';
  let vibrantColorHex = '#2b7256';
  try {
    // get average color using fast-average-color-node
    const color = await getAverageColor(buffer);
    averageColorHex = color.hex;
  } catch (error) {
    logger.error('Error fetching average color:', error);
  }
  try {
    // get vibrant color using node-vibrant
    const pallete = await Vibrant.from(buffer).getPalette();
    if (pallete.Vibrant) {
      vibrantColorHex = pallete.Vibrant.hex;
    }
  } catch (error) {
    logger.error('Error fetching vibrant color', error);
  } finally {
    buffer = undefined;
  }
  return { width, height, averageColorHex, vibrantColorHex };
};

export default computeMetadataForImage;
