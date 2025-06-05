import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListTag } from '../../types/List';
import { BUNDLE_METADATA_PATHS, BUNDLE_STORAGE_PATHS, BUNDLE_NAMES, NAMED_QUERIES } from '../../shared/bundleConstants';

const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: BUNDLE_NAMES.BIBLE_CHAPTERS,
    namedQueryName: NAMED_QUERIES.BIBLE_CHAPTERS,
    bundlePath: BUNDLE_STORAGE_PATHS.BIBLE_CHAPTERS,
    metadataDocPath: BUNDLE_METADATA_PATHS.BIBLE_CHAPTERS,
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