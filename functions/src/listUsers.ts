import { auth } from 'firebase-admin';
import { https, logger } from 'firebase-functions';

const listUsers = https.onCall(async (data, context) => {
  // check if user is admin (true "admin" custom claim), return error if not
  if (context?.auth?.token.role !== 'admin') {
    return { error: `Unauthorized.` };
  }
  try {
    const listUsersResult = await auth().listUsers();
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