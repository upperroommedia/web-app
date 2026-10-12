import { mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { Bucket } from '@google-cloud/storage';
import { StorageObjectData } from 'firebase-functions/v2/storage';
import { modifyImage } from '../../resize-image';
import computeMetadataForImage from '../../computeMetadataForImage';

jest.mock('fast-average-color-node', () => ({ getAverageColor: jest.fn() }));
jest.mock('node-vibrant/node', () => ({ Vibrant: {} }));
jest.mock('firebase-functions', () => ({ logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

let fixtureDirectory: string;
let originalFile: string;

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'image-processing-test-'));
  originalFile = path.join(fixtureDirectory, 'original.png');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#123456' } }).png().toFile(originalFile);
});

afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test('reads dimensions through image-size v2 for local files and buffers', async () => {
  const fromFile = await computeMetadataForImage(originalFile, true);
  const fromBuffer = await computeMetadataForImage(await readFile(originalFile), true);
  expect(fromFile).toEqual({ width: 80, height: 40, averageColorHex: '', vibrantColorHex: '' });
  expect(fromBuffer).toEqual(fromFile);
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
