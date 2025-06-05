import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListTag } from '../../types/List';
import { BUNDLE_METADATA_PATHS, BUNDLE_STORAGE_PATHS, BUNDLE_NAMES, NAMED_QUERIES } from '../../shared/bundleConstants';

const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: BUNDLE_NAMES.SUNDAY_HOMILIES,
    namedQueryName: NAMED_QUERIES.SUNDAY_HOMILIES,
    bundlePath: BUNDLE_STORAGE_PATHS.SUNDAY_HOMILIES,
    metadataDocPath: BUNDLE_METADATA_PATHS.SUNDAY_HOMILIES,
    countFieldName: 'sundayHomilies',
    displayName: 'sunday homilies',
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.SUNDAY_HOMILY_MONTH }
    ]
};

export const createSundayHomilyBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(SUNDAY_HOMILY_BUNDLE_CONFIG, request, response);
    }
);

export { SUNDAY_HOMILY_BUNDLE_CONFIG }; 