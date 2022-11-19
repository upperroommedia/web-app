/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from 'firebase-functions/v2';
import { storage, firestore } from 'firebase-admin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { File } from '@google-cloud/storage';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import axios from 'axios';
import { ImageType } from '../../types/Image';
import { ISpeaker } from '../../types/Speaker';
import { Stream } from 'stream';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { uuid } from 'uuidv4';
export interface populateSpeakerImagesInputType {
  speakerTagIds?: string[];
}
import sizeOf from 'image-size';

export interface populateSpeakerImagesOutputType {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
}

const getImageDimensions = async (file: File): Promise<{ width: number; height: number }> => {
  if (!existsSync(os.tmpdir())) {
    mkdirSync(os.tmpdir());
  }
  const tempFilePath = path.join(os.tmpdir(), uuid());
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
const populateSpeakerImages = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (request: CallableRequest<populateSpeakerImagesInputType>): Promise<void> => {
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('failed-precondition', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Populating Speaker Images');
      let page_number = 1;
      const page_size = 100;
      let loop = true;
      let current = 0;
      const bearerToken = await authenticateSubsplash();
      const bucket = storage().bucket('urm-app-images');
      const db = firestore();
      db.settings({ ignoreUndefinedProperties: true });
      const firestoreSpeakers = db.collection('speakers');
      const firestoreImages = db.collection('images');

      logger.log('loop starting');
      const promises = [];
      while (loop) {
        // get all speakers
        const axiosConfig = createAxiosConfig(
          `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=speaker&include=image&page%5Bnumber%5D=${page_number}&page%5Bsize%5D=${page_size}&sort=title`,
          bearerToken,
          'GET',
          undefined,
          { 'collection-total': 'include' }
        );
        const response = (await axios(axiosConfig)).data;
        current += response.count;
        logger.log(`Retrieved ${current} of ${response.total} speaker tags`);
        page_number += 1;
        if (current >= response.total) {
          loop = false;
        }
        const speakers = response._embedded.tags;
        // get first sermon for each speaker
        // push promises to array to make the rest of the calls asyncronously
        promises.push(
          ...speakers.map(async (speaker: any) => {
            const speakerId = speaker.id;
            const speakerName = speaker.title;
            const speakerSermonCount = speaker.tagging_count;

            logger.log(`Retrieving sermons for ${speakerName}`);
            const getSermonItemAxiosConfig = createAxiosConfig(
              `https://core.subsplash.com/tags/v1/taggings?filter%5Bapp_key%5D=9XTSHD&filter%5Btag.id%5D=${speakerId}&include=media-item&page%5Bsize%5D=1&sort=-created_at`,
              bearerToken,
              'GET'
            );
            // get images from sermon
            const axiosResponse = await axios(getSermonItemAxiosConfig);
            const sermonTitle = axiosResponse.data._embedded.taggings[0]._embedded['media-item'].title;
            logger.log(`Gettimg Images for ${speakerName} from ${sermonTitle}`);
            const subsplashImages =
              axiosResponse.data?._embedded?.taggings[0]?._embedded['media-item']?._embedded?.images;

            if (!subsplashImages) return;
            // map over images and upload them to storage
            // create metadata for each image
            const images: ImageType[] = await Promise.all(
              subsplashImages.map(async (image: any): Promise<ImageType | undefined> => {
                const imageId = image.id;
                let width = image.width;
                let height = image.height;
                const averageColorHex = image.average_color_hex;
                const vibrantColorHex = image.vibrant_color_hex;
                const contentType = image.content_type || 'image/jpeg';
                const type = image.type as ImageType['type'];

                // fetch image from subsplash
                logger.log(`Fetching ${type} image ${imageId} for ${speakerName}`);
                const response = await axios({
                  method: 'GET',
                  url: `https://images.subsplash.com/image.jpg?id=${imageId}`,
                  responseType: 'stream',
                });
                const destinationFilePath = `speaker-images/${imageId}-${type}.${contentType.split('/')[1]}`;
                const file = bucket.file(destinationFilePath);
                if ((await file.exists())[0]) {
                  logger.warn(`Image ${imageId} already exists ... skipping to next image`);
                  return;
                }

                // stream image to storage bucket
                logger.log(`Uploading ${type} ${contentType} ${width}x${height} image ${imageId} for ${speakerName}`);
                await streamDataToStorage(response.data, file);
                logger.log(`Uploaded ${type} image ${imageId} for ${speakerName}`);
                // get image dimensions if not provided
                if (!width || !height) {
                  logger.log(`Getting dimensions for ${type} image ${imageId} for ${speakerName}`);
                  const dimensions = await getImageDimensions(file);
                  width = dimensions.width;
                  height = dimensions.height;
                }
                logger.log(`Dimensions ${width}x${height} for ${type} image ${imageId} for ${speakerName}`);
                // update storage metadata
                // logger.log(`Updating metadata for ${destinationFilePath}`);
                // await file.setMetadata({
                //   contentType: contentType,
                //   metadata: {
                //     width: width,
                //     height: height,
                //     average_color_hex: averageColorHex,
                //     vibrant_color_hex: vibrantColorHex,
                //   },
                // });

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
                  name: `${speakerName}-${type}.${contentType.split('/')[1]}`,
                  subsplashId: imageId,
                  averageColorHex: averageColorHex,
                  vibrantColorHex: vibrantColorHex,
                };
                logger.log(`Final Image: ${JSON.stringify(finalImage)}`);
                await firestoreImages.add(finalImage);
                return finalImage;
              })
            );

            // update speaker tag with image url
            const speakerData: ISpeaker = {
              id: speakerId,
              name: speakerName,
              images: images.filter((image) => image !== undefined),
              tagId: speakerId,
              sermonCount: speakerSermonCount,
            };
            logger.log(`Updating firestore document speakers/${speakerId} with ${JSON.stringify(speakerData)}`);
            await firestoreSpeakers.doc(speakerId).set(speakerData, { merge: true });
            logger.log(`Updated firestore document speakers/${speakerId} with ${JSON.stringify(speakerData)}`);
          })
        );
        logger.log('promises', promises);
      }
      logger.log('loop done');
      // wait until all the calls finish
      await Promise.all(promises);
      logger.log(`Finished updating ${current} speakers`);
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        throw new HttpsError('internal', error.message, error.toJSON());
      }
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      throw new HttpsError('internal', 'Unknown error');
    }
  }
);

export default populateSpeakerImages;
