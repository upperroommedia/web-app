import firebaseAdmin from '../../firebase/firebaseAdmin';
import { beforeUserCreated } from 'firebase-functions/v2/identity';

const setUserRoleOnCreate = beforeUserCreated(async (event) => {
  // Ensure user data exists
  if (!event.data) {
    throw new Error('User data is missing from the event');
  }

  // In development/emulator mode, default to 'admin' role for easier testing
  // In production, default to 'user' role for security
  const defaultRole = process.env.FUNCTIONS_EMULATOR === 'true' ? 'admin' : 'user';

  // Set custom claims using Admin SDK
  // Note: This still needs to happen via Admin SDK as blocking functions 
  // can modify user data but custom claims require separate Admin SDK call
  await firebaseAdmin.auth().setCustomUserClaims(event.data.uid, { role: defaultRole });

  // Blocking functions can return modified user data, but for custom claims
  // we rely on the Admin SDK call above. We could return custom data here
  // if needed for other user properties.
  return {};
});

export default setUserRoleOnCreate;
