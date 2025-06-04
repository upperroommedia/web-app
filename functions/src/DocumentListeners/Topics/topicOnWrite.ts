import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { TOPIC_BUNDLE_CONFIG } from '../../createTopicBundle';
import { createBundleDocumentListener, BundleListenerConfig } from '../../utils/bundleListenerUtils';

const TOPIC_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: 'topics/{topicId}',
    bundleRegenerationFunction: () => generateAndStoreBundle(TOPIC_BUNDLE_CONFIG),
    displayName: 'topic',
    metadataDocPath: 'metadata/topic-bundle',
    shouldTrigger: (): boolean => {
        // Always trigger for any topic changes
        return true;
    }
};

const topicOnWrite = createBundleDocumentListener(TOPIC_LISTENER_CONFIG);

export default topicOnWrite; 