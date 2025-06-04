import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { List, ListTag } from '../../types/List';

const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'sunday-homilies-bundle',
    namedQueryName: 'latest-sunday-homilies-query',
    bundlePath: 'bundles/sunday-homilies-bundle.bin',
    metadataDocPath: 'metadata/sunday-homily-bundle',
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