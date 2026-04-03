import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import addintrooutrotaskgenerator from './addIntroOutroTaskGenerator';
import getyoutubecookiestatus from './getYouTubeCookieStatus';
import { processaudiofiletask, processaudioyoutubetask } from './processAudioTask';
import setyoutubecookies from './setYouTubeCookies';

setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret],
});

exports.addintrooutrotaskgenerator = addintrooutrotaskgenerator;
exports.processaudiofiletask = processaudiofiletask;
exports.processaudioyoutubetask = processaudioyoutubetask;
exports.getyoutubecookiestatus = getyoutubecookiestatus;
exports.setyoutubecookies = setyoutubecookies;
