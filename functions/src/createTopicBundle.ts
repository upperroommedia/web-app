import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminTopicConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { Topic } from '../../types/Topic';
import { BUNDLE_METADATA_PATHS, BUNDLE_STORAGE_PATHS, BUNDLE_NAMES, NAMED_QUERIES } from '../../shared/bundleConstants';

const TOPIC_BUNDLE_CONFIG: BundleCreationConfig<Topic> = {
    collectionName: 'topics',
    converter: firestoreAdminTopicConverter,
    bundleName: BUNDLE_NAMES.TOPICS,
    namedQueryName: NAMED_QUERIES.TOPICS,
    bundlePath: BUNDLE_STORAGE_PATHS.TOPICS,
    metadataDocPath: BUNDLE_METADATA_PATHS.TOPICS,
    countFieldName: 'topics',
    displayName: 'topics',
    orderByField: 'title'
};

export const createTopicBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(TOPIC_BUNDLE_CONFIG, request, response);
    }
);

export { TOPIC_BUNDLE_CONFIG }; 