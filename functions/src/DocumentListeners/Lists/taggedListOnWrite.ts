import { createBundleDocumentListener } from '../../utils/bundleListenerUtils';
import { BIBLE_CHAPTER_BUNDLE_CONFIG, SUNDAY_HOMILY_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';

const bibleChapterListOnWrite = createBundleDocumentListener(BIBLE_CHAPTER_BUNDLE_CONFIG);
const sundayHomilyListOnWrite = createBundleDocumentListener(SUNDAY_HOMILY_BUNDLE_CONFIG);

export { bibleChapterListOnWrite, sundayHomilyListOnWrite }; 