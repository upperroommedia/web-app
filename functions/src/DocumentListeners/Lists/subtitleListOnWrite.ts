
import { createBundleDocumentListener } from '../../utils/bundleListenerUtils';
import { SUBTITLE_BUNDLE_CONFIG } from '../../../../shared/bundleConfigs';


const subtitleListOnWrite = createBundleDocumentListener(SUBTITLE_BUNDLE_CONFIG);

export default subtitleListOnWrite; 