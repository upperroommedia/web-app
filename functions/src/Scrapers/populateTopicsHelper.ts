import axios from 'axios';
import { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { ImageType } from '../../../types/Image';
import { List, ListType } from '../../../types/List';
import { Topic } from '../../../types/Topic';
import { createAxiosConfig } from '../subsplashUtils';

async function populateTopics(
  db: Firestore,
  bearerToken: string,
  firestoreImagesMap: Map<string, ImageType>,
  listIdToImageIdMap: Map<string, string[]>,
  listNameToId: Map<string, string>,
  firestoreLists: CollectionReference<List>,
  firestoreTopics: CollectionReference<Topic>
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    topics.forEach((topic: any) => {
      const listId = listNameToId.get(topic.title);
      const imageIds = listId ? listIdToImageIdMap.get(listId) : [];
      const images = imageIds
        ? (imageIds
            .map((imageId) => firestoreImagesMap.get(imageId))
            .filter((image) => image !== undefined) as ImageType[])
        : [];
      const topicData: Topic = {
        id: topic.id,
        title: topic.title,
        itemsCount: topic.tagging_count,
        images,
        ...(listId && { listId: listId }),
        createdAtMillis:
          new Date(topic.created_at).getTime() || new Date(topic.updated_at).getTime() || new Date().getTime(),
        updatedAtMillis:
          new Date(topic.updated_at).getTime() || new Date(topic.created_at).getTime() || new Date().getTime(),
      };
      batch.set(firestoreTopics.doc(topicData.id), topicData, { merge: true });
      if (listId) {
        batch.set(firestoreLists.doc(listId), { type: ListType.TOPIC_LIST }, { merge: true });
      }
      logger.log(`Updated firestore document topics/${topicData.id} for ${topicData.title}`);
    });
    await batch.commit();
  }
  return current;
}

export default populateTopics;
