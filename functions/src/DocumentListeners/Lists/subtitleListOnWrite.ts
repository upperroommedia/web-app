import { List, ListType } from '../../../../types/List';
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { SUBTITLE_BUNDLE_CONFIG } from '../../createSubtitleBundle';
import { createBundleDocumentListener, BundleListenerConfig } from '../../utils/bundleListenerUtils';
import { BUNDLE_METADATA_PATHS, COLLECTION_PATHS } from '../../../../shared/bundleConstants';

const SUBTITLE_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: COLLECTION_PATHS.SUBTITLES,
    bundleRegenerationFunction: () => generateAndStoreBundle(SUBTITLE_BUNDLE_CONFIG),
    displayName: 'subtitle list',
    metadataDocPath: BUNDLE_METADATA_PATHS.SUBTITLES,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        // Only trigger for category lists (subtitles)
        return (beforeData?.type === ListType.CATEGORY_LIST) || (afterData?.type === ListType.CATEGORY_LIST);
    }
};

const subtitleListOnWrite = createBundleDocumentListener(SUBTITLE_LISTENER_CONFIG);

export default subtitleListOnWrite; 