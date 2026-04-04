import '../../functions/src/sentry';
import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import { functionsSentryDsnSecret, initFunctionsSentry } from '../../functions/src/sentry';
initFunctionsSentry();
setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret, functionsSentryDsnSecret],
});

import uploadimage from '../../functions/src/handleImageUpload';
import saveimage from '../../functions/src/saveImage';
import getimage from '../../functions/src/getImage';
import { updateImageMetadata } from '../../functions/src/helpers/updateImageMetadata';
import imageOnDelete from '../../functions/src/DocumentListeners/Images/imageOnDelete';

exports.uploadimage = uploadimage;
exports.saveimage = saveimage;
exports.getimage = getimage;
exports.updateimagemetadata = updateImageMetadata;
exports.imageondelete = imageOnDelete;
