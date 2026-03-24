
import { createBundleDocumentListener } from '../../utils/bundleListenerUtils';
import { SUBTITLE_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';


const subtitleListOnWrite = createBundleDocumentListener(SUBTITLE_BUNDLE_CONFIG);

export default subtitleListOnWrite; 