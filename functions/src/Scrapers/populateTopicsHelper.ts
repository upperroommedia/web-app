import axios from 'axios';
import { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { ImageType } from '@upperroom/shared/types/Image';
import { List, ListType } from '@upperroom/shared/types/List';
import { Topic } from '@upperroom/shared/types/Topic';
import { createAxiosConfig } from '../subsplashUtils';

interface SubsplashTopicTag {
  id: string;
  title: string;
  tagging_count: number;
  created_at: string;
  updated_at: string;
}

interface SubsplashTopicsResponse {
  count: number;
  total: number;
  _embedded: {
    tags: SubsplashTopicTag[];
  };
}

function toTimestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function shouldReplaceTopicForList(existing: SubsplashTopicTag, candidate: SubsplashTopicTag): boolean {
  if (candidate.tagging_count !== existing.tagging_count) {
    return candidate.tagging_count > existing.tagging_count;
  }

  const existingUpdated = toTimestamp(existing.updated_at);
  const candidateUpdated = toTimestamp(candidate.updated_at);
  if (candidateUpdated !== existingUpdated) {
    return candidateUpdated > existingUpdated;
  }

  return candidate.id > existing.id;
}

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
  const fetchedTopics: SubsplashTopicTag[] = [];

  while (loop) {
    // get all topics
    const axiosConfig = createAxiosConfig(
      `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=topic&include=image&page%5Bnumber%5D=${pageNumber}&page%5Bsize%5D=${pageSize}&sort=title`,
      bearerToken,
      'GET',
      undefined,
      { 'collection-total': 'include' }
    );

    const response: SubsplashTopicsResponse = (await axios(axiosConfig)).data;
    current += response.count;
    logger.log(`Retrieved ${current} of ${response.total} speaker tags`);
    pageNumber += 1;
    if (current >= response.total) {
      loop = false;
    }
    fetchedTopics.push(...response._embedded.tags);
  }

  const chosenTopicByListId = new Map<string, SubsplashTopicTag>();
  const topicsWithoutListId: SubsplashTopicTag[] = [];

  for (const topic of fetchedTopics) {
    const listId = listNameToId.get(topic.title);
    if (!listId) {
      topicsWithoutListId.push(topic);
      continue;
    }

    const existing = chosenTopicByListId.get(listId);
    if (!existing || shouldReplaceTopicForList(existing, topic)) {
      chosenTopicByListId.set(listId, topic);
    }
  }

  const dedupedTopics = [...topicsWithoutListId, ...chosenTopicByListId.values()];
  const duplicatesSkipped = fetchedTopics.length - dedupedTopics.length;
  if (duplicatesSkipped > 0) {
    logger.log(`Deduped ${duplicatesSkipped} duplicate topic tag(s) by listId before saving.`);
  }

  const existingTopicsSnapshot = await firestoreTopics.get();
  const existingTopicDocIdsByListId = new Map<string, string[]>();
  existingTopicsSnapshot.docs.forEach((docSnapshot) => {
    const topic = docSnapshot.data();
    if (!topic.listId) {
      return;
    }
    const existing = existingTopicDocIdsByListId.get(topic.listId) ?? [];
    existing.push(docSnapshot.id);
    existingTopicDocIdsByListId.set(topic.listId, existing);
  });

  const bulkWriter = db.bulkWriter();
  const seenTopicDeletes = new Set<string>();

  for (const topic of dedupedTopics) {
    const listId = listNameToId.get(topic.title);
    const imageIds = listId ? listIdToImageIdMap.get(listId) : [];
    const images = imageIds
      ? imageIds.map((imageId) => firestoreImagesMap.get(imageId)).filter((image): image is ImageType => image !== undefined)
      : [];

    const topicData: Topic = {
      id: topic.id,
      title: topic.title,
      itemsCount: topic.tagging_count,
      images,
      ...(listId && { listId }),
      createdAtMillis: toTimestamp(topic.created_at) || toTimestamp(topic.updated_at) || Date.now(),
      updatedAtMillis: toTimestamp(topic.updated_at) || toTimestamp(topic.created_at) || Date.now(),
    };

    bulkWriter.set(firestoreTopics.doc(topicData.id), topicData, { merge: true });
    logger.log(`Updated firestore document topics/${topicData.id} for ${topicData.title}`);

    if (listId) {
      bulkWriter.set(firestoreLists.doc(listId), { type: ListType.TOPIC_LIST }, { merge: true });

      const existingDocIds = existingTopicDocIdsByListId.get(listId) ?? [];
      existingDocIds.forEach((docId) => {
        if (docId !== topicData.id && !seenTopicDeletes.has(docId)) {
          bulkWriter.delete(firestoreTopics.doc(docId));
          seenTopicDeletes.add(docId);
          logger.log(`Removed duplicate topic document topics/${docId} for listId ${listId}`);
        }
      });
    }
  }

  await bulkWriter.close();
  return current;
}

export default populateTopics;
