import '../../functions/src/sentry';
import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import { functionsSentryDsnSecret, initFunctionsSentry } from '../../functions/src/sentry';
import { providerEgressRelayTokenSecret } from '../../functions/src/providerRelay';
initFunctionsSentry();
setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret, functionsSentryDsnSecret, providerEgressRelayTokenSecret],
});

import uploadimage from '../../functions/src/handleImageUpload';

exports.uploadimage = uploadimage;
