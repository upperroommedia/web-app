import { auth as adminauth } from 'firebase-admin';
import { auth } from 'firebase-functions';

const setUserRoleOnCreate = auth.user().onCreate(async (user) => {
  await adminauth().setCustomUserClaims(user.uid, { role: 'user' });
});

export default setUserRoleOnCreate;
