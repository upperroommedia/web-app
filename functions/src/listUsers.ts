import firebaseAdmin from '../../firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';

const listUsers = https.onCall(async (opts) => {
  // check if user is admin (true "admin" custom claim), return error if not
  if (opts.auth?.token.role !== 'admin') {
    return { error: `Unauthorized.` };
  }
  try {
    const listUsersResult = await firebaseAdmin.auth().listUsers();
    // go through users array, and deconstruct user objects down to required fields
    const result = listUsersResult.users.map((user) => {
      return {
        uid: user.uid,
        email: user.email,
        photoURL: user.photoURL,
        displayName: user.displayName,
        role: user.customClaims?.role,
      };
    });
    return { result };
  } catch (error) {
    logger.error(error);
    let message = 'Unknown Error';
    if (error instanceof Error) message = error.message;
    return message;
  }
});

export default listUsers;
