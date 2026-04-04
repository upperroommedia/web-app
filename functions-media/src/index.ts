import '../../functions/src/sentry';
import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import { functionsSentryDsnSecret, initFunctionsSentry } from '../../functions/src/sentry';
import addintrooutrotaskgenerator from './addIntroOutroTaskGenerator';
import getyoutubecookiestatus from './getYouTubeCookieStatus';
import { processaudiofiletask, processaudioyoutubetask } from './processAudioTask';
import setyoutubecookies from './setYouTubeCookies';

initFunctionsSentry();

setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret, functionsSentryDsnSecret],
});

exports.addintrooutrotaskgenerator = addintrooutrotaskgenerator;
exports.processaudiofiletask = processaudiofiletask;
exports.processaudioyoutubetask = processaudioyoutubetask;
exports.getyoutubecookiestatus = getyoutubecookiestatus;
exports.setyoutubecookies = setyoutubecookies;
