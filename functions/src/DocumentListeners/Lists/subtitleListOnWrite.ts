import { List, ListType } from '../../../../types/List';
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { SUBTITLE_BUNDLE_CONFIG } from '../../createSubtitleBundle';
import { createBundleDocumentListener, BundleListenerConfig } from '../../utils/bundleListenerUtils';

const SUBTITLE_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: 'lists/{listId}',
    bundleRegenerationFunction: () => generateAndStoreBundle(SUBTITLE_BUNDLE_CONFIG),
    displayName: 'subtitle list',
    metadataDocPath: 'metadata/subtitle-bundle',
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        // Only trigger for category lists (subtitles)
        return (beforeData?.type === ListType.CATEGORY_LIST) || (afterData?.type === ListType.CATEGORY_LIST);
    }
};

const subtitleListOnWrite = createBundleDocumentListener(SUBTITLE_LISTENER_CONFIG);

export default subtitleListOnWrite; 