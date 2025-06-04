import { onRequest } from 'firebase-functions/v2/https';
import { firestoreAdminTopicConverter } from './firestoreDataConverter';
import { createBundleHandler, BundleCreationConfig } from './utils/bundleCreationUtils';
import { Topic } from '../../types/Topic';

const TOPIC_BUNDLE_CONFIG: BundleCreationConfig<Topic> = {
    collectionName: 'topics',
    converter: firestoreAdminTopicConverter,
    bundleName: 'topics-bundle',
    namedQueryName: 'latest-topics-query',
    bundlePath: 'bundles/topics-bundle.bin',
    metadataDocPath: 'metadata/topic-bundle',
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