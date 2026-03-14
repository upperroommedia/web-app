import { createBundleDocumentListener } from '../../utils/bundleListenerUtils';
import { TOPIC_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';

const topicOnWrite = createBundleDocumentListener(TOPIC_BUNDLE_CONFIG);

export default topicOnWrite; 