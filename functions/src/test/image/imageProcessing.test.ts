import { mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { Bucket } from '@google-cloud/storage';
import { StorageObjectData } from 'firebase-functions/v2/storage';
import { modifyImage } from '../../resize-image';
import computeMetadataForImage from '../../computeMetadataForImage';
import { getAverageColor } from 'fast-average-color-node';
import { Vibrant } from 'node-vibrant/node';
import { imageSize } from 'image-size';

jest.mock('fast-average-color-node', () => ({ getAverageColor: jest.fn() }));
const mockGetPalette = jest.fn();
jest.mock('node-vibrant/node', () => ({ Vibrant: { from: jest.fn(() => ({ getPalette: mockGetPalette })) } }));
jest.mock('firebase-functions', () => ({ logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

let fixtureDirectory: string;
let originalFile: string;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(getAverageColor).mockResolvedValue({
    rgb: 'rgb(18,52,86)',
    rgba: 'rgba(18,52,86,1)',
    hex: '#123456',
    hexa: '#123456ff',
    value: [18, 52, 86, 255],
    isDark: true,
    isLight: false,
  });
  mockGetPalette.mockResolvedValue({ Vibrant: { hex: '#abcdef' } });
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'image-processing-test-'));
  originalFile = path.join(fixtureDirectory, 'original.png');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#123456' } })
    .png()
    .toFile(originalFile);
});

afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test('preserves original dimensions for validated local files and buffers', async () => {
  const fromFile = await computeMetadataForImage(originalFile, true);
  const fromBuffer = await computeMetadataForImage(await readFile(originalFile), true);
  expect(fromFile).toEqual({ width: 80, height: 40, averageColorHex: '', vibrantColorHex: '' });
  expect(fromBuffer).toEqual(fromFile);
});

const malformedAsfSvg = () => {
  const header = Buffer.alloc(55);
  Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]).copy(header);
  return Buffer.concat([header, Buffer.from('<svg width="1" height="1"></svg>')]);
};
test.each([true, false])(
  'rejects ASF/SVG polyglot before either secondary parser (dimensionsOnly=%s)',
  async (dimensionsOnly) => {
    const input = malformedAsfSvg();
    // This is why header sniffing was insufficient: image-size accepts the appended SVG.
    expect(imageSize(input)).toMatchObject({ type: 'svg', width: 1, height: 1 });
    await expect(computeMetadataForImage(input, dimensionsOnly)).rejects.toMatchObject({ name: 'ImageInputInvalid' });
    expect(getAverageColor).not.toHaveBeenCalled();
    expect(Vibrant.from).not.toHaveBeenCalled();
  }
);
test('dimensions-only callers reject an image header whose pixel data cannot decode', async () => {
  const truncated = (await readFile(originalFile)).subarray(0, 40);
  expect(imageSize(truncated)).toMatchObject({ width: 80, height: 40 });
  await expect(computeMetadataForImage(truncated, true)).rejects.toMatchObject({ name: 'ImageInputInvalid' });
  expect(Vibrant.from).not.toHaveBeenCalled();
});
test.each(['png', 'jpeg', 'webp', 'gif', 'tiff'] as const)(
  'decodes real %s and passes only bounded encoded PNG to color libraries',
  async (format) => {
    const input = await sharp({ create: { width: 512, height: 256, channels: 3, background: '#123456' } })
      .toFormat(format)
      .toBuffer();
    const result = await computeMetadataForImage(input);
    expect(result).toEqual({ width: 512, height: 256, averageColorHex: '#123456', vibrantColorHex: '#abcdef' });
    const sample = jest.mocked(getAverageColor).mock.calls[0][0];
    expect(Buffer.isBuffer(sample)).toBe(true);
    expect(await sharp(sample).metadata()).toMatchObject({ format: 'png', width: 128, height: 64 });
    expect(jest.mocked(Vibrant.from).mock.calls[0][0]).toBe(sample);
  }
);
test('valid SVG is rasterized before secondary parsing without changing reported dimensions', async () => {
  const input = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#123456"/></svg>'
  );
  expect(await computeMetadataForImage(input)).toMatchObject({ width: 400, height: 200 });
  expect(await sharp(jest.mocked(getAverageColor).mock.calls[0][0]).metadata()).toMatchObject({
    format: 'png',
    width: 128,
    height: 64,
  });
});
test('preserves alpha rather than inventing a palette background', async () => {
  const input = await sharp({
    create: { width: 8, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  await computeMetadataForImage(input);
  const sample = jest.mocked(getAverageColor).mock.calls[0][0];
  expect(await sharp(sample).metadata()).toMatchObject({ hasAlpha: true });
  const { data, info } = await sharp(sample).raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  expect(data[3]).toBeGreaterThan(0);
  expect(data[3]).toBeLessThan(255);
});
test('reports original EXIF dimensions while keeping sampling independent of display metadata', async () => {
  const input = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#123456' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  expect(await computeMetadataForImage(input)).toMatchObject({ width: 8, height: 4 });
  const metadata = await sharp(jest.mocked(getAverageColor).mock.calls[0][0]).metadata();
  expect(metadata).toMatchObject({ format: 'png', width: 8, height: 4 });
  expect(metadata.orientation).toBeUndefined();
});
test('samples only the first frame of a real animated GIF', async () => {
  const pixels = Buffer.alloc(4 * 8 * 4);
  for (let pixel = 0; pixel < 32; pixel++) {
    pixels[pixel * 4 + (pixel < 16 ? 0 : 2)] = 255;
    pixels[pixel * 4 + 3] = 255;
  }
  const input = await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
    .gif({ delay: [100, 100] })
    .toBuffer();
  expect((await sharp(input, { animated: true }).metadata()).pages).toBe(2);
  expect(await computeMetadataForImage(input)).toMatchObject({ width: 4, height: 4 });
  const pixel = await sharp(jest.mocked(getAverageColor).mock.calls[0][0]).raw().toBuffer();
  expect(pixel[0]).toBe(255);
  expect(pixel[2]).toBe(0);
});
test.each([
  [20000, 1],
  [8192, 8192],
])('rejects oversized dimensions %sx%s before color libraries', async (width, height) => {
  const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`);
  await expect(computeMetadataForImage(input)).rejects.toMatchObject({ name: 'ImageInputInvalid' });
  expect(Vibrant.from).not.toHaveBeenCalled();
});
test('retains stable fallback colors when genuine extraction libraries fail after valid decoding', async () => {
  jest.mocked(getAverageColor).mockRejectedValue(new Error('color extraction failed'));
  mockGetPalette.mockRejectedValue(new Error('palette extraction failed'));
  expect(await computeMetadataForImage(originalFile)).toEqual({
    width: 80,
    height: 40,
    averageColorHex: '#9fccb9',
    vibrantColorHex: '#2b7256',
  });
});

test('rejects invalid image headers', async () => {
  await writeFile(originalFile, 'not an image');
  await expect(computeMetadataForImage(originalFile, true)).rejects.toThrow();
});

test('resizes and encodes concurrently without sharing temporary files', async () => {
  const uploadedPaths: string[] = [];
  const outputs: Buffer[] = [];
  const makePublic = jest.fn().mockResolvedValue(undefined);
  const upload = jest.fn(async (filename: string) => {
    uploadedPaths.push(filename);
    outputs.push(await readFile(filename));
    return [{ makePublic }];
  });
  const bucket = { upload } as unknown as Bucket;
  const parameters = {
    bucket,
    originalFile,
    fileDir: 'speaker-images',
    fileNameWithoutExtension: 'same-image',
    fileExtension: '.png',
    contentType: 'image/webp' as const,
    size: { width: 20, height: 20, sizeType: 'thumbnail' as const },
    objectMetadata: { metadata: { firebaseStorageDownloadTokens: 'original-token' } } as unknown as StorageObjectData,
    format: 'webp' as const,
  };
  const results = await Promise.all([modifyImage(parameters), modifyImage(parameters)]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(results[0].outputFilePath).toBe('speaker-images/resized/same-image_thumbnail.webp');
  expect(new Set(uploadedPaths).size).toBe(2);
  for (const output of outputs) {
    expect(await sharp(output).metadata()).toMatchObject({ width: 20, height: 10, format: 'webp' });
  }
  for (const filename of uploadedPaths) {
    await expect(access(path.dirname(filename))).rejects.toThrow();
  }
  expect(makePublic).toHaveBeenCalledTimes(2);
});

test('cleans temporary output when a storage upload fails', async () => {
  let uploadedPath = '';
  const upload = jest.fn(async (filename: string) => {
    uploadedPath = filename;
    throw new Error('storage unavailable');
  });
  const result = await modifyImage({
    bucket: { upload } as unknown as Bucket,
    originalFile,
    fileDir: 'speaker-images',
    fileNameWithoutExtension: 'image',
    fileExtension: '.png',
    contentType: 'image/jpeg',
    size: { width: 20, height: 20, sizeType: 'thumbnail' },
    objectMetadata: {} as StorageObjectData,
    format: 'jpg',
  });
  expect(result.success).toBe(false);
  expect(uploadedPath).not.toBe('');
  await expect(access(path.dirname(uploadedPath))).rejects.toThrow();
});
