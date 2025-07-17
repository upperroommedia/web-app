import { firestoreAdminListConverter, firestoreAdminTopicConverter } from '../functions/src/firestoreDataConverter';
import { FirestoreDataConverter } from 'firebase-admin/firestore';
import { Topic } from '../types/Topic';
import { List, ListTag, ListType } from '../types/List';
import { isEqual, omit } from 'lodash';

export interface BundleConfig<T> {
  bundleType: string;
  functionName: string;
  namedQuery: string;
  cacheKeyPrefix: string;
  displayName: string;
  metadataDocPath: string;
  bundlePath: string;
  collectionName: string;
  collectionPath: string;
  converter: FirestoreDataConverter<T>;
  shouldTrigger: (beforeData: any, afterData: any) => boolean;
  orderByField?: string;
  whereConditions?: Array<{ field: string; operator: any; value: any }>;
}

export const TOPIC_BUNDLE_CONFIG: BundleConfig<Topic> = {
  bundleType: 'topics',
  functionName: 'createtopicbundle',
  namedQuery: 'latest-topics-query',
  cacheKeyPrefix: 'topic',
  displayName: 'topics',
  metadataDocPath: 'bundle-metadata/topic-bundle',
  bundlePath: 'bundles/topics-bundle.bin',
  collectionName: 'topics',
  collectionPath: 'topics/{topicId}',
  converter: firestoreAdminTopicConverter,
  shouldTrigger: () => true,
  orderByField: 'title',
};

export const SUBTITLE_BUNDLE_CONFIG: BundleConfig<List> = {
  bundleType: 'subtitles',
  functionName: 'createsubtitlebundle',
  namedQuery: 'latest-subtitles-query',
  cacheKeyPrefix: 'subtitle',
  displayName: 'subtitles',
  metadataDocPath: 'bundle-metadata/subtitle-bundle',
  bundlePath: 'bundles/subtitles-bundle.bin',
  collectionName: 'lists',
  collectionPath: 'lists/{listId}',
  converter: firestoreAdminListConverter,
  shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
    // Only trigger for category lists (subtitles)
    return beforeData?.type === ListType.CATEGORY_LIST || afterData?.type === ListType.CATEGORY_LIST;
  },
  orderByField: 'name',
  whereConditions: [{ field: 'type', operator: '==', value: ListType.CATEGORY_LIST }],
};
const fieldsToOmit = ['createdAtMillis', 'updatedAtMillis', 'count'];
export const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleConfig<List> = {
  bundleType: 'bible-chapters',
  functionName: 'createbiblechapterbundle',
  namedQuery: 'latest-bible-chapters-query',
  cacheKeyPrefix: 'bible-chapter',
  displayName: 'bible chapters',
  metadataDocPath: 'bundle-metadata/bible-chapter-bundle',
  bundlePath: 'bundles/bible-chapters-bundle.bin',
  collectionName: 'lists',
  collectionPath: 'lists/{listId}',
  converter: firestoreAdminListConverter,
  shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
    // Only trigger for bible chapter lists
    return (
      (!isEqual(
        omit(beforeData?.listTagAndPosition, fieldsToOmit),
        omit(afterData?.listTagAndPosition, fieldsToOmit)
      ) &&
        beforeData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER) ||
      afterData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER
    );
  },
  orderByField: 'listTagAndPosition.position',
  whereConditions: [{ field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.BIBLE_CHAPTER }],
};

export const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleConfig<List> = {
  bundleType: 'sunday-homilies',
  functionName: 'createsundayhomilybundle',
  namedQuery: 'latest-sunday-homilies-query',
  cacheKeyPrefix: 'sunday-homily',
  displayName: 'sunday homilies',
  metadataDocPath: 'bundle-metadata/sunday-homily-bundle',
  bundlePath: 'bundles/sunday-homilies-bundle.bin',
  collectionName: 'lists',
  collectionPath: 'lists/{listId}',
  converter: firestoreAdminListConverter,
  shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
    // Only trigger for sunday homily lists
    return (
      !isEqual(omit(beforeData?.listTagAndPosition, fieldsToOmit), omit(afterData?.listTagAndPosition, fieldsToOmit)) &&
      (beforeData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH ||
        afterData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH)
    );
  },
  orderByField: 'listTagAndPosition.position',
  whereConditions: [{ field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.SUNDAY_HOMILY_MONTH }],
};

export const LATEST_LIST_BUNDLE_CONFIG: BundleConfig<List> = {
  bundleType: 'latest-list',
  functionName: 'createlatestlistbundle',
  namedQuery: 'latest-list-query',
  cacheKeyPrefix: 'latest-list',
  displayName: 'latest list',
  metadataDocPath: 'bundle-metadata/latest-list',
  bundlePath: 'bundles/latest-list.bun',
  collectionName: 'lists',
  collectionPath: 'lists/{listId}',
  converter: firestoreAdminListConverter,
  shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
    return beforeData?.type === ListType.LATEST || afterData?.type === ListType.LATEST;
  },
  whereConditions: [
    {
      field: 'type',
      operator: '==',
      value: ListType.LATEST,
    },
  ],
};

// Extract bundle types from the configs
type BundleType =
  | typeof TOPIC_BUNDLE_CONFIG.bundleType
  | typeof SUBTITLE_BUNDLE_CONFIG.bundleType
  | typeof BIBLE_CHAPTER_BUNDLE_CONFIG.bundleType
  | typeof SUNDAY_HOMILY_BUNDLE_CONFIG.bundleType
  | typeof LATEST_LIST_BUNDLE_CONFIG.bundleType;

// Create count property type
type BundleCountProps = {
  [K in BundleType as `${K}-count`]?: number;
};

export interface BundleMetadata extends BundleCountProps {
  lastUpdated: number;
  storagePath: string;
}
