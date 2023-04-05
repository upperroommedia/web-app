import { Bucket } from '@google-cloud/storage';
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { Topic } from '../../../types/Topic';
import { createAxiosConfig } from '../subsplashUtils';

async function populateTopics(
  db: firestore.Firestore,
  bearerToken: string,
  firestoreTopics: firestore.CollectionReference<Topic>
): Promise<number> {
  let loop = true;
  let current = 0;
  let pageNumber = 1;
  const pageSize = 100;
  while (loop) {
    // get all topics
    const axiosConfig = createAxiosConfig(
      `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=topic&include=image&page%5Bnumber%5D=${pageNumber}&page%5Bsize%5D=${pageSize}&sort=title`,
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
    const topics = response._embedded.tags;
    // get first sermon for each speaker
    // push promises to array to make the rest of the calls asyncronously
    const batch = db.batch();
    topics.forEach((topic: any) => {
      const topicData: Topic = {
        id: topic.id,
        title: topic.title,
        itemsCount: topic.tagging_count,
        createdAtMillis: new Date(topic.created_at).getTime(),
        updatedAtMillis: new Date(topic.updated_at).getTime(),
      };
      batch.set(firestoreTopics.doc(topicData.id), topicData, { merge: true });
      logger.log(`Updated firestore document topics/${topicData.id} for ${topicData.title}`);
    });
    await batch.commit();
  }
  return current;
}

export default populateTopics;
