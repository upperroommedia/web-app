import { adminAuth } from '../../firebase/initFirebaseAdmin';
import { auth } from 'firebase-functions';

const setUserRoleOnCreate = auth.user().onCreate(async (user) => {
  await adminAuth.setCustomUserClaims(user.uid, { role: 'user' });
});

export default setUserRoleOnCreate;
