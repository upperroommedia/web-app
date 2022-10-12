// To deploy functions: npm run-script deploy
// To test functions: npm run-script serve

import * as admin from 'firebase-admin';
import uploadToSubsplash from './uploadToSubsplash';
import trimAudioOnStorage from './trimAudioOnStorage';
import setUserRole from './setUserRole';

admin.initializeApp();

exports.uploadToSubsplash = uploadToSubsplash;
exports.trimAudioOnStorage = trimAudioOnStorage;
exports.setUserRole = setUserRole;
