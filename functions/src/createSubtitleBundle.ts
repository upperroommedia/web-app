import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListType } from '../../types/List';

const SUBTITLE_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'subtitles-bundle',
    namedQueryName: 'latest-subtitles-query',
    bundlePath: 'bundles/subtitles-bundle.bin',
    metadataDocPath: 'metadata/subtitle-bundle',
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