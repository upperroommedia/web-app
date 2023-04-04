import { Bucket } from '@google-cloud/storage';
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { ImageType } from '../../../types/Image';
import { List, ListType } from '../../../types/List';
import { ISpeaker } from '../../../types/Speaker';
import { createAxiosConfig } from '../subsplashUtils';
import populateImages from './populateImagesHelper';

async function populateSpeakers(
  db: firestore.Firestore,
  bucket: Bucket,
  bearerToken: string,
  imageIds: Set<string>,
  firestoreImagesMap: Map<string, ImageType>,
  listIdToImageIdMap: Map<string, string[]>,
  listNameToId: Map<string, string>,
  firestoreLists: firestore.CollectionReference<List>,
  firestoreSpeakers: firestore.CollectionReference<ISpeaker>
): Promise<number> {
  const speakersWithNoListImages: ISpeaker[] = [];
  let loop = true;
  let current = 0;
  let pageNumber = 1;
  const pageSize = 100;
  while (loop) {
    // get all speakers
    const axiosConfig = createAxiosConfig(
      `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=speaker&include=image&page%5Bnumber%5D=${pageNumber}&page%5Bsize%5D=${pageSize}&sort=title`,
      bearerToken,
      'GET',
      undefined,
      { 'collection-total': 'include' }
    );
    const response = (await axios(axiosConfig)).data;
    current += response.count;
    logger.log(`Retrieved ${current} of ${response.total} speaker tags`);
    pageNumber += 1;
    if (current >= response.total) {
      loop = false;
    }
    const speakers = response._embedded.tags;
    // get first sermon for each speaker
    // push promises to array to make the rest of the calls asyncronously
    const batch = db.batch();
    speakers.forEach((speaker: any) => {
      const speakerId = speaker.id;
      const speakerName = speaker.title;
      const speakerSermonCount = speaker.tagging_count;
      const listId = listNameToId.get(speakerName);
      const imageIds = listId ? listIdToImageIdMap.get(listId) : [];
      const images = imageIds
        ? (imageIds
            .map((imageId) => firestoreImagesMap.get(imageId))
            .filter((image) => image !== undefined) as ImageType[])
        : [];

      const speakerData: ISpeaker = {
        id: speakerId,
        name: speakerName,
        images,
        tagId: speakerId,
        sermonCount: speakerSermonCount,
        ...(listId && { listId: listId }),
      };
      if (images.length === 0) {
        speakersWithNoListImages.push(speakerData);
      } else {
        // update speaker tag with image url
        batch.set(firestoreSpeakers.doc(speakerId), speakerData, { merge: true });
        if (listId) {
          batch.set(firestoreLists.doc(listId), { type: ListType.SPEAKER_LIST }, { merge: true });
        }
        logger.log(`Updated firestore document speakers/${speakerId} for ${speakerName}`);
      }
    });
    await batch.commit();
  }

  // get images for remaining speakers
  logger.log(`Getting Images for ${speakersWithNoListImages.length} speakers with no list images`);
  const remainingSpeakerImages = new Map<string, { imageName: string; image: any }>();
  const speakerIdToImagesMap = new Map<string, string[]>();
  await Promise.all(
    speakersWithNoListImages.map(async (speakerData) => {
      const getSermonItemAxiosConfig = createAxiosConfig(
        `https://core.subsplash.com/tags/v1/taggings?filter%5Bapp_key%5D=9XTSHD&filter%5Btag.id%5D=${speakerData.id}&include=media-item&page%5Bsize%5D=1&sort=-created_at`,
        bearerToken,
        'GET'
      );
      // get images from sermon
      const data = await (await axios(getSermonItemAxiosConfig)).data;
      if (!data) {
        logger.log(`No data found for ${speakerData.id}, ${speakerData.name}`);
        return;
      }
      const sermonTitle = data._embedded?.taggings[0]?._embedded['media-item']?.title;
      logger.log(`Getting Images for ${speakerData.name} from ${sermonTitle}`);
      const images = data._embedded?.taggings[0]?._embedded['media-item']?._embedded?.images;
      if (!images) {
        logger.log(`No images found for ${speakerData.id}, ${speakerData.name}`);
        return;
      }
      images.forEach((image: any) => {
        if (image.id) {
          remainingSpeakerImages.set(image.id, { imageName: speakerData.name, image });
        }
      });
      speakerIdToImagesMap.set(
        speakerData.id,
        images.map((image: any) => image.id)
      );
    })
  );
  const subsplashImagesInput: { imageName: string; image: any }[] = [];
  remainingSpeakerImages.forEach((value) => subsplashImagesInput.push(value));
  await populateImages(bucket, imageIds, db, subsplashImagesInput, firestoreImagesMap);

  const chunkSize = 250;
  for (let i = 0; i < speakersWithNoListImages.length; i += chunkSize) {
    const chunk = speakersWithNoListImages.slice(i, i + chunkSize);
    const batch = db.batch();
    chunk.forEach((speaker) => {
      const imageIds = speakerIdToImagesMap.get(speaker.id) || [];
      const images = imageIds
        ? (imageIds
            .map((imageId) => firestoreImagesMap.get(imageId))
            .filter((image) => image !== undefined) as ImageType[])
        : [];
      batch.set(firestoreSpeakers.doc(speaker.id), { ...speaker, ...(images && { images: images }) }, { merge: true });
      if (speaker.listId) {
        batch.set(firestoreLists.doc(speaker.listId), { type: ListType.SPEAKER_LIST }, { merge: true });
      }
      logger.log(`Updated firestore document speakers/${speaker.id} for ${speaker.name}`);
    });
    await batch.commit();
  }
  return current;
}

export default populateSpeakers;
