// To deploy functions: npm run-script deploy
// To test functions: npm run-script serve

import * as admin from 'firebase-admin';
import uploadToSubsplash from './uploadToSubsplash';
import setUserRole from './setUserRole';
import addintrooutro from './addIntroOutro';
import deleteFromSubsplash from './deleteFromSubsplash';
import getimage from './getImage';
admin.initializeApp();

exports.uploadToSubsplash = uploadToSubsplash;
exports.deleteFromSubsplash = deleteFromSubsplash;
exports.setUserRole = setUserRole;
exports.addintrooutro = addintrooutro;
exports.getimage = getimage;
