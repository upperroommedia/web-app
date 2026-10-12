/* eslint-disable  @typescript-eslint/no-explicit-any */
import * as os from 'os';
import sharp from 'sharp';
import * as path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { logger } from 'firebase-functions';
import { resizeType, supportedContentTypes } from '@upperroom/shared/types/Image';
import { Bucket } from '@google-cloud/storage';
import { v4 as uuid } from 'uuid';
import { StorageObjectData } from 'firebase-functions/v2/storage';

type resizeFormat = 'jpg' | 'jpeg' | 'png' | 'tif' | 'tiff' | 'webp' | 'gif';

export interface ResizedImageResult {
  size: resizeType;
  outputFilePath: string;
  success: boolean;
}

 
export function convertType(buffer: Buffer, format: resizeFormat, outputOptions?: any) {
  if (format === 'jpeg') {
    return sharp(buffer).jpeg(outputOptions).toBuffer();
  }

  if (format === 'jpg') {
    return sharp(buffer).jpeg(outputOptions).toBuffer();
  }

  if (format === 'png') {
    return sharp(buffer).png(outputOptions).toBuffer();
  }

  if (format === 'webp') {
    return sharp(buffer).webp(outputOptions).toBuffer();
  }

  if (format === 'tif') {
    return sharp(buffer).tiff(outputOptions).toBuffer();
  }

  if (format === 'tiff') {
    return sharp(buffer).tiff(outputOptions).toBuffer();
  }

  if (format === 'gif') {
    return sharp(buffer).gif(outputOptions).toBuffer();
  }

  return buffer;
}

/**
 * Supported file types
 */

export const supportedImageContentTypeMap = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tif',
  tiff: 'image/tiff',
  webp: 'image/webp',
  gif: 'image/gif',
};

const supportedExtensions = Object.keys(supportedImageContentTypeMap).map((type) => `.${type}`);

export const modifyImage = async ({
  bucket,
  originalFile,
  fileDir,
  fileNameWithoutExtension,
  fileExtension,
  contentType,
  size,
  objectMetadata,
  format,
}: {
  bucket: Bucket;
  originalFile: string;
  fileDir: string;
  fileNameWithoutExtension: string;
  fileExtension: string;
  contentType: supportedContentTypes;
  size: resizeType;
  objectMetadata: StorageObjectData;
  format: resizeFormat;
}): Promise<ResizedImageResult> => {
  const modifiedExtensionName = fileExtension ? `.${format}` : fileExtension;

  let modifiedFileName;

  if (supportedExtensions.includes(fileExtension.toLowerCase())) {
    modifiedFileName = `${fileNameWithoutExtension}_${size.sizeType}${modifiedExtensionName}`;
  } else {
    // Fixes https://github.com/firebase/extensions/issues/476
    modifiedFileName = `${fileNameWithoutExtension}${fileExtension}_${size.sizeType}`;
  }

  // Path where modified image will be uploaded to in Storage.
  const modifiedFilePath = path.normalize(path.join(fileDir, '/resized', modifiedFileName));
  let modifiedFile = '';
  let temporaryDirectory = '';

  try {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'resized-image-'));
    modifiedFile = path.join(temporaryDirectory, modifiedFileName);

    // filename\*=utf-8''  selects any string match the filename notation.
    // [^;\s]+ searches any following string until either a space or semi-colon.
    const contentDisposition =
      objectMetadata && objectMetadata.contentDisposition
        ? objectMetadata.contentDisposition.replace(
            /(filename\*=utf-8''[^;\s]+)/,
            `filename*=utf-8''${modifiedFileName}`
          )
        : '';

    // Cloud Storage files.
    const metadata: { [key: string]: any } = {
      contentDisposition,
      contentEncoding: objectMetadata.contentEncoding,
      contentLanguage: objectMetadata.contentLanguage,
      contentType: contentType,
      metadata: objectMetadata.metadata ? { ...objectMetadata.metadata } : {},
    };
    metadata.metadata.resizedImage = true;
    // if (config.cacheControlHeader) {
    //   metadata.cacheControl = config.cacheControlHeader;
    // } else {
    metadata.cacheControl = objectMetadata.cacheControl;
    // }

    // If the original image has a download token, add a
    // new token to the image being resized #323
    if (metadata.metadata.firebaseStorageDownloadTokens) {
      metadata.metadata.firebaseStorageDownloadTokens = uuid();
    }

    // Resize and encode directly to disk in a single Sharp pipeline.
    logger.log(`Resizing image at path '${modifiedFile}' to size: ${size.sizeType}`);
    await sharp(originalFile, { failOn: 'none' })
      .rotate()
      .resize(size.width, size.height, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(format === 'jpg' ? 'jpeg' : format === 'tif' ? 'tiff' : format)
      .toFile(modifiedFile);
    logger.log(`Resized image created at '${modifiedFile}'`);

    // Uploading the modified image.
    logger.log(`Uploading resized image to '${modifiedFilePath}'`);
    const uploadResponse = await bucket.upload(modifiedFile, {
      destination: modifiedFilePath,
      metadata,
    });
    logger.log(`Uploaded resized image to '${modifiedFile}'`);

    // Make uploaded image public.
    await uploadResponse[0].makePublic();

    return { size, outputFilePath: modifiedFilePath, success: true };
  } catch (err) {
    logger.error('Error when resizing image', err);
    return { size, outputFilePath: modifiedFilePath, success: false };
  } finally {
    try {
      // Make sure the local resized file is cleaned up to free up disk space.
      if (temporaryDirectory) {
        logger.log(`Deleting temporary resized file: '${modifiedFilePath}'`);
        await rm(temporaryDirectory, { recursive: true, force: true });
        logger.log(`Deleted temporary resized file: '${modifiedFilePath}'`);
      }
    } catch (err) {
      logger.warn('Error when deleting temporary files', err);
    }
  }
};
