import '../../functions/src/sentry';
import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
import { functionsSentryDsnSecret, initFunctionsSentry } from '../../functions/src/sentry';
import addintrooutrotaskgenerator from './addIntroOutroTaskGenerator';
import getyoutubecookiestatus from './getYouTubeCookieStatus';
import { processaudiofiletask, processaudioyoutubetask } from './processAudioTask';
import recoverDeferredMosesAudio from './recoverDeferredMosesAudio';
import setyoutubecookies from './setYouTubeCookies';
import sermonAudioCreateTrigger from './sermonAudioCreateTrigger';

initFunctionsSentry();

setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret, functionsSentryDsnSecret],
});

exports.addintrooutrotaskgenerator = addintrooutrotaskgenerator;
exports.processaudiofiletask = processaudiofiletask;
exports.processaudioyoutubetask = processaudioyoutubetask;
exports.recoverdeferredmosesaudio = recoverDeferredMosesAudio;
exports.getyoutubecookiestatus = getyoutubecookiestatus;
exports.setyoutubecookies = setyoutubecookies;
exports.sermonaudiocreatetrigger = sermonAudioCreateTrigger;
