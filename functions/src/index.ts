// To deploy functions: npm run-script deploy
// To test functions: npm run-script serve

import * as admin from 'firebase-admin';
import uploadToSubsplash from './uploadToSubsplash';
import setUserRole from './setUserRole';
import addintrooutro from './addIntroOutro';
import deleteFromSubsplash from './deleteFromSubsplash';
import uploadimage from './handleImageUpload';
import saveimage from './saveImage';
import getimage from './getImage';
import listusers from './listUsers';
import setUserRoleOnCreate from './setUserRoleOnCreate';
import populatespeakerimages from './populateSpeakerImages';
import createnewsubsplashlist from './createNewSubsplashList';
import addToSeries from './addToSeries';
import uploadtosoundcloud from './uploadToSoundCloud';
import deletefromsoundcloud from './deleteFromSoundCloud';
import editSubsplashSermon from './editSubsplashSermon';
import editSoundCloudSermon from './editSoundCloudSermon';

admin.initializeApp();

exports.uploadToSubsplash = uploadToSubsplash;
exports.editSubsplashSermon = editSubsplashSermon;
exports.editSoundCloudSermon = editSoundCloudSermon;
exports.deleteFromSubsplash = deleteFromSubsplash;
exports.setUserRole = setUserRole;
exports.addintrooutro = addintrooutro;
exports.uploadimage = uploadimage;
exports.getimage = getimage;
exports.listusers = listusers;
exports.setuserroleoncreate = setUserRoleOnCreate;
exports.populatespeakerimages = populatespeakerimages;
exports.createnewsubsplashlist = createnewsubsplashlist;
exports.addtoseries = addToSeries;
exports.saveimage = saveimage;
exports.uploadtosoundcloud = uploadtosoundcloud;
exports.deletefromsoundcloud = deletefromsoundcloud;
