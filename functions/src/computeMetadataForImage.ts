import { getAverageColor } from 'fast-average-color-node';
import { MMCQ } from '@vibrant/quantizer-mmcq';
import { DefaultGenerator } from '@vibrant/generator-default';
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

/** Only accepts pixels decoded from the bounded, freshly encoded Sharp sample. */
export const vibrantHexFromRgba = async ({
  data,
  width,
  height,
  channels,
}: {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}): Promise<string | undefined> => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 128 ||
    height > 128 ||
    channels !== 4 ||
    !(data instanceof Uint8Array) ||
    data.length !== width * height * 4
  ) {
    throw new Error('Palette input must be bounded RGBA pixels');
  }
  // Preserve Vibrant's default quality=5 sample dimensions. Sharp replaces
  // Jimp's area resizer, so edge interpolation may differ slightly.
  const pixels = await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(Math.max(1, Math.round(width / 5)), Math.max(1, Math.round(height / 5)), { kernel: 'linear', fit: 'fill' })
    .raw()
    .toBuffer();
  let eligiblePixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    // Exact node-vibrant default filter; never invent a background for alpha.
    if (pixels[offset + 3] < 125 || (pixels[offset] > 250 && pixels[offset + 1] > 250 && pixels[offset + 2] > 250)) {
      pixels[offset + 3] = 0;
    } else {
      eligiblePixels++;
    }
  }
  if (eligiblePixels === 0) return undefined;
  const palette = await DefaultGenerator(MMCQ(pixels, { colorCount: 64 }));
  const hex = palette.Vibrant?.hex;
  if (hex !== undefined && !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Invalid vibrant color');
  return hex;
};

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
    const { data, info } = await sharp(buffer)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hex = await vibrantHexFromRgba({ data, ...info });
    if (hex) vibrantColorHex = hex;
  } catch (error) {
    logger.error('Error fetching vibrant color', error);
  }
  return { width, height, averageColorHex, vibrantColorHex };
};

export default computeMetadataForImage;
