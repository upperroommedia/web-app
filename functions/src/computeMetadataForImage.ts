import { getAverageColor } from 'fast-average-color-node';
import { Vibrant } from 'node-vibrant/node';
import { logger } from 'firebase-functions';
import sharp from 'sharp';
import axios from 'axios';
import { readFile } from 'fs/promises';

interface ImageMetadata {
  width: number;
  height: number;
  averageColorHex: string;
  vibrantColorHex: string;
}

const loadImageBuffer = async (source: string | Buffer): Promise<Buffer> => {
  if (Buffer.isBuffer(source)) {
    return source;
  }

  if (/^https?:\/\//i.test(source)) {
    try {
      const response = await axios.get(source, { responseType: 'arraybuffer' });
      return Buffer.from(response.data, 'binary');
    } catch (error) {
      logger.error('Error fetching image:', error);
      throw new Error('Failed to fetch image from URL');
    }
  }

  try {
    return await readFile(source);
  } catch (error) {
    logger.error('Error reading image file:', error);
    throw new Error('Failed to read image from file');
  }
};

const computeMetadataForImage = async (source: string | Buffer, dimensionsOnly = false): Promise<ImageMetadata> => {
  const input = await loadImageBuffer(source);
  let width: number;
  let height: number;
  let buffer: Buffer;
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384)
      throw new Error('Image dimensions exceed the processing limit');
    width = metadata.width;
    height = metadata.height;
    // Decode before passing bytes to secondary image parsers. Header-only
    // detection can accept malformed/polyglot input; palette work needs only
    // a small, freshly encoded image, not the original full-resolution file.
    buffer = await image.resize({ width: 128, height: 128, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    const error = new Error('Image cannot be decoded within the processing limits');
    error.name = 'ImageInputInvalid';
    throw error;
  }
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
  }
  return { width, height, averageColorHex, vibrantColorHex };
};

export default computeMetadataForImage;
