import firestore, { collection, doc, getDoc, getDocs, limit, query, where } from '../firebase/firestore';
import { isDiscoverableRootList } from './algolia/searchRecords';
import { List, listConverter, ListType } from '../types/List';
import { Sermon } from '../types/SermonTypes';

const uniqueById = (lists: List[]): List[] => {
  const seen = new Set<string>();
  return lists.filter((list) => {
    if (seen.has(list.id)) {
      return false;
    }
    seen.add(list.id);
    return true;
  });
};

const fetchListById = async (listId: string): Promise<List | null> => {
  const snapshot = await getDoc(doc(firestore, 'lists', listId).withConverter(listConverter));
  if (!snapshot.exists()) {
    return null;
  }

  const list = snapshot.data();
  return isDiscoverableRootList(list) ? list : null;
};

const fetchSingleListByName = async (name: string, type: ListType): Promise<List | null> => {
  const listQuery = query(
    collection(firestore, 'lists'),
    where('name', '==', name),
    where('type', '==', type),
    limit(5)
  ).withConverter(listConverter);
  const listQuerySnapshot = await getDocs(listQuery);
  const matchingList = listQuerySnapshot.docs
    .map((docSnapshot) => docSnapshot.data())
    .find(isDiscoverableRootList);
  return matchingList ?? null;
};

export const resolveCanonicalSermonLists = async (sermon: Sermon, sermonList: List[]): Promise<List[]> => {
  const mergedLists = [...sermonList];

  const existingIds = new Set(mergedLists.map((list) => list.id));
  const existingTopicNames = new Set(
    mergedLists.filter((list) => list.type === ListType.TOPIC_LIST).map((list) => list.name)
  );
  const hasSubtitleList = mergedLists.some(
    (list) => list.type === ListType.CATEGORY_LIST && list.name === sermon.subtitle
  );

  const missingSpeakerListIds = sermon.speakers.reduce<string[]>((listIds, speaker) => {
    if (speaker.listId && !existingIds.has(speaker.listId)) {
      listIds.push(speaker.listId);
    }
    return listIds;
  }, []);

  const speakerLists = await Promise.all(missingSpeakerListIds.map((listId) => fetchListById(listId)));

  speakerLists.forEach((list) => {
    if (list) {
      mergedLists.push(list);
      existingIds.add(list.id);
    }
  });

  if (sermon.subtitle && !hasSubtitleList) {
    const subtitleList = await fetchSingleListByName(sermon.subtitle, ListType.CATEGORY_LIST);
    if (subtitleList && !existingIds.has(subtitleList.id)) {
      mergedLists.push(subtitleList);
      existingIds.add(subtitleList.id);
    }
  }

  const missingTopicNames = sermon.topics.filter((topic) => !existingTopicNames.has(topic));
  const topicLists = await Promise.all(
    missingTopicNames.map((topicName) => fetchSingleListByName(topicName, ListType.TOPIC_LIST))
  );

  topicLists.forEach((list) => {
    if (list && !existingIds.has(list.id)) {
      mergedLists.push(list);
      existingIds.add(list.id);
    }
  });

  return uniqueById(mergedLists);
};
