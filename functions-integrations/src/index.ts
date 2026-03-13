import { setGlobalOptions } from 'firebase-functions/v2';
import { runtimeAlertRecipientsSecret } from '../../functions/src/notifications/notificationSecrets';
setGlobalOptions({
  secrets: [runtimeAlertRecipientsSecret],
});

import generatesecuredapikey from '../../functions/src/generateAlgoliaSecureApiKey';
import uploadToSubsplash from '../../functions/src/uploadToSubsplash';
import deleteFromSubsplash from '../../functions/src/deleteFromSubsplash';
import editSubsplashSermon from '../../functions/src/editSubsplashSermon';
import editSoundCloudSermon from '../../functions/src/editSoundCloudSermon';
import uploadtosoundcloud from '../../functions/src/uploadToSoundCloud';
import deletefromsoundcloud from '../../functions/src/deleteFromSoundCloud';
import populatedatabasefromsubsplash from '../../functions/src/Scrapers/populateDatabaseFromSubsplash';
import createnewsubsplashlist from '../../functions/src/createNewSubsplashList';
import deletesubsplashlist from '../../functions/src/deleteSubsplashList';
import editsubsplashlist from '../../functions/src/editSubsplashList';
import repopulatelistfromspeakeritems from '../../functions/src/Scrapers/repopulateListFromSpeakerItems';
import tagitemsinlist from '../../functions/src/Scrapers/tagItemsInList';
import { fixPhantomListItems } from '../../functions/src/Scrapers/fixPhantomListItems';
import { updateSubsplashTag } from '../../functions/src/Scrapers/updateSubsplashTag';

exports.generatesecuredapikey = generatesecuredapikey;
exports.uploadToSubsplash = uploadToSubsplash;
exports.deletefromsubsplash = deleteFromSubsplash;
exports.editSubsplashSermon = editSubsplashSermon;
exports.editSoundCloudSermon = editSoundCloudSermon;
exports.uploadtosoundcloud = uploadtosoundcloud;
exports.deletefromsoundcloud = deletefromsoundcloud;
exports.populatedatabasefromsubsplash = populatedatabasefromsubsplash;
exports.createnewsubsplashlist = createnewsubsplashlist;
exports.deletesubsplashlist = deletesubsplashlist;
exports.editsubsplashlist = editsubsplashlist;
exports.repopulatelistfromspeakeritems = repopulatelistfromspeakeritems;
exports.tagitemsinlist = tagitemsinlist;
exports.fixphantomlistitems = fixPhantomListItems;
exports.updatesubsplashtag = updateSubsplashTag;
