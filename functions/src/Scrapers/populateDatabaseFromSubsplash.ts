/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from 'firebase-functions/v2';
import { storage, firestore } from 'firebase-admin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import axios from 'axios';
import { ISpeaker } from '../../../types/Speaker';
export interface populateDatabaseFromSubsplashInputType {
  speakerTagIds?: string[];
}
import handleError from '../handleError';
import { firestoreAdminListConverter, firestoreAdminSpeakerConverter } from '../firestoreDataConverter';
import populateListsFromSubsplash from './populateListsFromSubsplash';
import { ImageType } from '../../../types/Image';
import { ListType } from '../../../types/List';

export interface populateDatabaseFromSubsplashOutputType {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
}

const populateDatabaseFromSubsplash = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (request: CallableRequest<populateDatabaseFromSubsplashInputType>): Promise<string> => {
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('failed-precondition', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Populating Database from Subsplash');
      let page_number = 1;
      const speakerPageSize = 100;
      let loop = true;
      let current = 0;
      const imageIds = new Set<string>();
      const firestoreImagesMap = new Map<string, ImageType>();
      const listIdToImageIdMap = new Map<string, string[]>();
      const listNameToId = new Map<string, string>();
      const bearerToken = await authenticateSubsplash();
      const bucket = storage().bucket('urm-app-images');
      const db = firestore();
      db.settings({ ignoreUndefinedProperties: true });
      const firestoreLists = db.collection('lists').withConverter(firestoreAdminListConverter);
      const firestoreSpeakers = db.collection('speakers').withConverter(firestoreAdminSpeakerConverter);
      const listCount = await populateListsFromSubsplash(
        db,
        bucket,
        bearerToken,
        imageIds,
        firestoreImagesMap,
        listIdToImageIdMap,
        listNameToId,
        firestoreLists
      );
      logger.log('loop starting');
      while (loop) {
        // get all speakers
        const axiosConfig = createAxiosConfig(
          `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=speaker&include=image&page%5Bnumber%5D=${page_number}&page%5Bsize%5D=${speakerPageSize}&sort=title`,
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
        const batch = db.batch();
        speakers.forEach(async (speaker: any) => {
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

          // update speaker tag with image url
          const speakerData: ISpeaker = {
            id: speakerId,
            name: speakerName,
            images,
            tagId: speakerId,
            sermonCount: speakerSermonCount,
            ...(listId && { listId: listId }),
          };
          batch.set(firestoreSpeakers.doc(speakerId), speakerData, { merge: true });
          if (listId) {
            batch.set(firestoreLists.doc(listId), { type: ListType.SPEAKER_LIST }, { merge: true });
          }
          logger.log(`Updated firestore document speakers/${speakerId} for ${speakerName}`);
        });
        await batch.commit();
      }

      logger.log('loop done');
      // wait until all the calls finish
      return `Finished updating ${listCount} lists, ${current} speakers, and ${firestoreImagesMap.size} images`;
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default populateDatabaseFromSubsplash;
