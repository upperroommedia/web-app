import firebaseAdmin from '../../firebase/firebaseAdmin';
import { auth } from 'firebase-functions';

const setUserRoleOnCreate = auth.user().onCreate(async (user) => {
  // In development/emulator mode, default to 'admin' role for easier testing
  // In production, default to 'user' role for security
  const defaultRole = process.env.FUNCTIONS_EMULATOR === 'true' ? 'admin' : 'user';

  await firebaseAdmin.auth().setCustomUserClaims(user.uid, { role: defaultRole });
});

export default setUserRoleOnCreate;
