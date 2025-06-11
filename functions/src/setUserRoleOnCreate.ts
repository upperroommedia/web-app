import firebaseAdmin from '../../firebase/firebaseAdmin';
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';

const setUserRoleOnCreate = beforeUserSignedIn(async (event) => {
  // Ensure user data exists
  if (!event.data) {
    throw new Error('User data is missing from the event');
  }

  // In development/emulator mode, default to 'admin' role for easier testing
  // In production, default to 'user' role for security
  const defaultRole = process.env.FUNCTIONS_EMULATOR === 'true' ? 'admin' : 'user';

  // Check if custom claims are already set to avoid overwriting
  const user = await firebaseAdmin.auth().getUser(event.data.uid);
  if (!user.customClaims || !user.customClaims.role) {
    // Set custom claims using Admin SDK
    await firebaseAdmin.auth().setCustomUserClaims(event.data.uid, { role: defaultRole });
  }

  // Return empty object to allow sign-in to proceed
  return {};
});

export default setUserRoleOnCreate;
