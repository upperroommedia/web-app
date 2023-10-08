import firebaseAdmin from '../../firebase/firebaseAdmin';
import { auth } from 'firebase-functions';

const setUserRoleOnCreate = auth.user().onCreate(async (user) => {
  await firebaseAdmin.auth().setCustomUserClaims(user.uid, { role: 'user' });
});

export default setUserRoleOnCreate;
