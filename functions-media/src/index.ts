import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret],
});

import addintrooutrotaskhandler from '../../functions/src/addIntroOutro/addintrooutrotaskhandler';
import addintrooutrotaskgenerator from '../../functions/src/addIntroOutro/addintrooutrotaskgenerator';

exports.addintrooutrotaskhandler = addintrooutrotaskhandler;
exports.addintrooutrotaskgenerator = addintrooutrotaskgenerator;
