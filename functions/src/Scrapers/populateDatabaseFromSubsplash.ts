/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from 'firebase-functions/v2';
import { db, storage } from '../../../firebase/firebaseAdmin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from '../subsplashUtils';
import { ImageType } from '../../../types/Image';
import {
  firestoreAdminListConverter,
  firestoreAdminSpeakerConverter,
  firestoreAdminTopicConverter,
} from '../firestoreDataConverter';
import populateLists from './populateListsHelper';
import populateSpeakers from './populateSpeakersHelper';
import populateTopics from './populateTopicsHelper';
import handleError from '../handleError';

export interface populateDatabaseFromSubsplashInputType {
  speakerTagIds?: string[];
}
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
      const imageIds = new Set<string>();
      const firestoreImagesMap = new Map<string, ImageType>();
      const listIdToImageIdMap = new Map<string, string[]>();
      const listNameToId = new Map<string, string>();
      const bearerToken = await authenticateSubsplash();
      const bucket = storage.bucket('urm-app-images');
      const firestoreLists = db.collection('lists').withConverter(firestoreAdminListConverter);
      const firestoreSpeakers = db.collection('speakers').withConverter(firestoreAdminSpeakerConverter);
      const firestoreTopics = db.collection('topics').withConverter(firestoreAdminTopicConverter);
      const listCount = await populateLists(
        db,
        bucket,
        bearerToken,
        imageIds,
        firestoreImagesMap,
        listIdToImageIdMap,
        listNameToId,
        firestoreLists
      );

      const speakerCount = await populateSpeakers(
        db,
        bucket,
        bearerToken,
        imageIds,
        firestoreImagesMap,
        listIdToImageIdMap,
        listNameToId,
        firestoreLists,
        firestoreSpeakers
      );

      const topicCount = await populateTopics(
        db,
        bearerToken,
        firestoreImagesMap,
        listIdToImageIdMap,
        listNameToId,
        firestoreLists,
        firestoreTopics
      );
      const completedMessage = `Finished updating ${listCount} lists, ${speakerCount} speakers, ${topicCount} topics, and ${firestoreImagesMap.size} images`;
      logger.log(completedMessage);
      return completedMessage;
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default populateDatabaseFromSubsplash;
