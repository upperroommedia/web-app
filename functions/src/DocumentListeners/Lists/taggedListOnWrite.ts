import { List, ListTag } from '../../../../types/List';
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { BIBLE_CHAPTER_BUNDLE_CONFIG } from '../../createBibleChapterBundle';
import { SUNDAY_HOMILY_BUNDLE_CONFIG } from '../../createSundayHomilyBundle';
import { createBundleDocumentListener, BundleListenerConfig } from '../../utils/bundleListenerUtils';
import { BUNDLE_METADATA_PATHS, COLLECTION_PATHS } from '../../../../shared/bundleConstants';

// Bible Chapter listener
const BIBLE_CHAPTER_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: COLLECTION_PATHS.BIBLE_CHAPTERS,
    bundleRegenerationFunction: () => generateAndStoreBundle(BIBLE_CHAPTER_BUNDLE_CONFIG),
    displayName: 'bible chapter list',
    metadataDocPath: BUNDLE_METADATA_PATHS.BIBLE_CHAPTERS,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        // Only trigger for bible chapter lists
        return (beforeData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER) ||
            (afterData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER);
    }
};

// Sunday Homily listener
const SUNDAY_HOMILY_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: COLLECTION_PATHS.SUNDAY_HOMILIES,
    bundleRegenerationFunction: () => generateAndStoreBundle(SUNDAY_HOMILY_BUNDLE_CONFIG),
    displayName: 'sunday homily list',
    metadataDocPath: BUNDLE_METADATA_PATHS.SUNDAY_HOMILIES,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        // Only trigger for sunday homily lists
        return (beforeData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH) ||
            (afterData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH);
    }
};

const bibleChapterListOnWrite = createBundleDocumentListener(BIBLE_CHAPTER_LISTENER_CONFIG);
const sundayHomilyListOnWrite = createBundleDocumentListener(SUNDAY_HOMILY_LISTENER_CONFIG);

export { bibleChapterListOnWrite, sundayHomilyListOnWrite }; 