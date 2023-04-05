import axios from 'axios';
import { firestore } from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { ImageType } from '../../../types/Image';
import { File, Bucket } from '@google-cloud/storage';
import { Stream } from 'stream';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { v4 } from 'uuid';
import sizeOf from 'image-size';
import { firestoreAdminImagesConverter } from '../firestoreDataConverter';

const getImageDimensions = async (file: File): Promise<{ width: number; height: number }> => {
  if (!existsSync(os.tmpdir())) {
    mkdirSync(os.tmpdir());
  }
  const tempFilePath = path.join(os.tmpdir(), v4());
  await file.download({ destination: tempFilePath });
  // Get Dimensions of the image
  const { width, height } = sizeOf(tempFilePath);
  // delete the temp file
  unlinkSync(tempFilePath);
  return { width: width || 0, height: height || 0 };
};

const streamDataToStorage = async (stream: Stream, destinationFile: File): Promise<void> => {
  return new Promise<void>((resolve) => {
    stream.pipe(destinationFile.createWriteStream()).on('close', resolve);
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function populateImages(
  bucket: Bucket,
  imageIds: Set<string>,
  db: firestore.Firestore,
  subsplashImages: { image: any; imageName: string }[],
  firestoreImagesMap: Map<string, ImageType>
): Promise<void> {
  const firestoreImages = db.collection('images').withConverter(firestoreAdminImagesConverter);
  await Promise.all(
    subsplashImages.map(async ({ image, imageName }): Promise<void> => {
      const imageId = image.id;
      const firebaseImage = await firestoreImages.doc(imageId).withConverter(firestoreAdminImagesConverter).get();

      if (firebaseImage.exists) {
        const image = firebaseImage.data();
        const storagePath = decodeURIComponent(image?.downloadLink.split('/').pop() || '');
        logger.log('storagePath', storagePath);
        const file = bucket.file(storagePath);
        if ((await file.exists())[0]) {
          imageIds.add(storagePath);
          logger.log(`${imageId} already exists, skipping download...`);
          if (image) {
            firestoreImagesMap.set(imageId, image);
          }
          return;
        }
      }
      let width = image.width;
      let height = image.height;
      const averageColorHex = image.average_color_hex;
      const vibrantColorHex = image.vibrant_color_hex;
      const contentType = image.content_type || 'image/jpeg';
      const type = image.type as ImageType['type'];
      // fetch image from subsplash
      logger.log(`Fetching ${type} image ${imageId} for ${imageName}`);
      const response = await axios({
        method: 'GET',
        url: `https://images.subsplash.com/image.jpg?id=${imageId}`,
        responseType: 'stream',
      });
      const destinationFilePath = `speaker-images/${imageId}-${type}.${contentType.split('/')[1]}`;
      const file = bucket.file(destinationFilePath);
      const shouldUploadImage = !imageIds.has(destinationFilePath);
      if (shouldUploadImage) {
        imageIds.add(destinationFilePath);
        // stream image to storage bucket
        logger.log(`Uploading ${type} ${contentType} ${width}x${height} image ${imageId} for ${imageName}`);
        await streamDataToStorage(response.data, file);
        logger.log(`Uploaded ${type} image ${imageId} for ${imageName}`);
      } else {
        logger.log(`Image: ${destinationFilePath} was already uploaded, skipping image...`);
      }
      // Getting dimensions if they don't exist in subslash request data
      if (!width || !height) {
        logger.log(`Getting dimensions for ${type} image ${imageId} for ${imageName}`);
        const dimensions = await getImageDimensions(file);
        width = dimensions.width;
        height = dimensions.height;
      }
      logger.log(`Dimensions ${width}x${height} for ${type} image ${imageId} for ${imageName}`);
      if (shouldUploadImage) {
        // get image dimensions if not provided
        // update storage metadata
        logger.log(`Updating metadata for ${destinationFilePath}`);
        await file.setMetadata({
          contentType: contentType,
          metadata: {
            width: width,
            height: height,
            ...(averageColorHex && { average_color_hex: averageColorHex }),
            ...(vibrantColorHex && { vibrant_color_hex: vibrantColorHex }),
          },
        });
      }

      // create firestore Image object
      const publicUrl = file.publicUrl();
      logger.log(`Public URL: ${publicUrl}`);
      const finalImage: ImageType = {
        id: imageId,
        size: 'original',
        type: type,
        height: height,
        width: width,
        downloadLink: publicUrl,
        dateAddedMillis: new Date().getTime(),
        name: `${imageName}-${type}.${contentType.split('/')[1]}`,
        subsplashId: imageId,
        ...(averageColorHex && { average_color_hex: averageColorHex }),
        ...(vibrantColorHex && { vibrant_color_hex: vibrantColorHex }),
      };
      if (shouldUploadImage) {
        await firestoreImages.doc(finalImage.id).set(finalImage, { merge: true });
      }
      logger.log(`Created image object for ${type} image ${imageId} for ${imageName}`);
      firestoreImagesMap.set(imageId, finalImage);
    })
  );
}

export default populateImages;
