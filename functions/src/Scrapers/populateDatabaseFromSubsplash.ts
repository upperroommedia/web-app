/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from 'firebase-functions/v2';
import { storage, firestore } from 'firebase-admin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { File } from '@google-cloud/storage';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import axios from 'axios';
import { ImageType } from '../../../types/Image';
import { ISpeaker } from '../../../types/Speaker';
import { Stream } from 'stream';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { v4 } from 'uuid';
export interface populateDatabaseFromSubsplashInputType {
  speakerTagIds?: string[];
}
import sizeOf from 'image-size';
import handleError from '../handleError';
import { firestoreAdminImagesConverter, firestoreAdminSpeakerConverter } from '../firestoreDataConverter';
import populateListsFromSubsplash from './populateListsFromSubsplash';

export interface populateDatabaseFromSubsplashOutputType {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
}

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
const populateDatabaseFromSubsplash = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (request: CallableRequest<populateDatabaseFromSubsplashInputType>): Promise<string> => {
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('failed-precondition', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Populating Database from Subsplash');
      let page_number = 1;
      // TODO[0]: UNCOMMENT
      // const page_size = 100;
      const page_size = 1000;
      let loop = true;
      let current = 0;
      let uploadedImages = 0;
      const imageIds: { [key: string]: boolean } = {};
      const bearerToken = await authenticateSubsplash();
      const bucket = storage().bucket('urm-app-images');
      const db = firestore();
      db.settings({ ignoreUndefinedProperties: true });
      const firestoreSpeakers = db.collection('speakers').withConverter(firestoreAdminSpeakerConverter);
      const firestoreImages = db.collection('images').withConverter(firestoreAdminImagesConverter);
      // console.log(speakerNameToListId);
      const speakerNameToListId: { [key: string]: string } = {};
      await populateListsFromSubsplash(db, bearerToken, speakerNameToListId, page_size);
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
        // TODO[1]: UNCOMMENT
        if (current >= 10) {
          // if (current >= response.total) {
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
                const shouldUploadImage = !imageIds[destinationFilePath];
                if (shouldUploadImage) {
                  imageIds[destinationFilePath] = true;
                  // stream image to storage bucket
                  logger.log(`Uploading ${type} ${contentType} ${width}x${height} image ${imageId} for ${speakerName}`);
                  await streamDataToStorage(response.data, file);
                  logger.log(`Uploaded ${type} image ${imageId} for ${speakerName}`);
                } else {
                  logger.log(`Image: ${destinationFilePath} was already uploaded, skipping image...`);
                }
                // Getting dimensions if they don't exist in subslash request data
                if (!width || !height) {
                  logger.log(`Getting dimensions for ${type} image ${imageId} for ${speakerName}`);
                  const dimensions = await getImageDimensions(file);
                  width = dimensions.width;
                  height = dimensions.height;
                }
                logger.log(`Dimensions ${width}x${height} for ${type} image ${imageId} for ${speakerName}`);
                if (shouldUploadImage) {
                  // get image dimensions if not provided
                  // update storage metadata
                  logger.log(`Updating metadata for ${destinationFilePath}`);
                  await file.setMetadata({
                    contentType: contentType,
                    metadata: {
                      width: width,
                      height: height,
                      average_color_hex: averageColorHex,
                      vibrant_color_hex: vibrantColorHex,
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
                  name: `${speakerName}-${type}.${contentType.split('/')[1]}`,
                  subsplashId: imageId,
                  averageColorHex: averageColorHex,
                  vibrantColorHex: vibrantColorHex,
                };
                logger.log(`Created image object for ${type} image ${imageId} for ${speakerName}`);
                if (shouldUploadImage) {
                  await firestoreImages.doc(finalImage.id).set(finalImage, { merge: true });
                  uploadedImages++;
                }
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
              listId: speakerNameToListId[speakerName],
            };
            logger.log(`Updating firestore document speakers/${speakerId} with ${JSON.stringify(speakerData)}`);
            await firestoreSpeakers.doc(speakerId).set(speakerData, { merge: true });
            logger.log(`Updated firestore document speakers/${speakerId} with ${JSON.stringify(speakerData)}`);
          })
        );
      }
      logger.log('loop done');
      // wait until all the calls finish
      await Promise.all(promises);
      return `Finished updating ${current} speakers, uploaded ${uploadedImages} images`;
    } catch (error) {
      handleError(error);
      return 'Error updating speakers';
    }
  }
);

export default populateDatabaseFromSubsplash;
