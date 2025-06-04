import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListTag } from '../../types/List';

const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'bible-chapters-bundle',
    namedQueryName: 'latest-bible-chapters-query',
    bundlePath: 'bundles/bible-chapters-bundle.bin',
    metadataDocPath: 'metadata/bible-chapter-bundle',
    countFieldName: 'bibleChapters',
    displayName: 'bible chapters',
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.BIBLE_CHAPTER }
    ]
};

export const createBibleChapterBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(BIBLE_CHAPTER_BUNDLE_CONFIG, request, response);
    }
);

export { BIBLE_CHAPTER_BUNDLE_CONFIG }; 