import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import addintrooutrotaskhandler from '../../functions/src/addIntroOutro/addintrooutrotaskhandler';
import addintrooutrotaskgenerator from '../../functions/src/addIntroOutro/addintrooutrotaskgenerator';

setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret],
});

exports.addintrooutrotaskhandler = addintrooutrotaskhandler;
exports.addintrooutrotaskgenerator = addintrooutrotaskgenerator;
