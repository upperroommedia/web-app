import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListType } from '../../types/List';
import { BUNDLE_METADATA_PATHS, BUNDLE_STORAGE_PATHS, BUNDLE_NAMES, NAMED_QUERIES } from '../../shared/bundleConstants';

const SUBTITLE_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: BUNDLE_NAMES.SUBTITLES,
    namedQueryName: NAMED_QUERIES.SUBTITLES,
    bundlePath: BUNDLE_STORAGE_PATHS.SUBTITLES,
    metadataDocPath: BUNDLE_METADATA_PATHS.SUBTITLES,
    countFieldName: 'subtitles',
    displayName: 'subtitles',
    orderByField: 'name',
    whereConditions: [
        { field: 'type', operator: '==', value: ListType.CATEGORY_LIST }
    ]
};

export const createSubtitleBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(SUBTITLE_BUNDLE_CONFIG, request, response);
    }
);

export { SUBTITLE_BUNDLE_CONFIG }; 