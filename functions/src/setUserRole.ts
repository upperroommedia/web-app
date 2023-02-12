import { ROLES } from '../../context/types';
import { auth } from 'firebase-admin';
import { https } from 'firebase-functions';

const setUserRole = https.onCall(async (data: { email: string; role: string }, context) => {
  if (context.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }
  if (!ROLES.includes(data.role)) {
    return { status: `Invalid Role: Should be either ${ROLES.join(', ')}` };
  }
  try {
    const user = await auth().getUserByEmail(data.email);
    if (user.customClaims?.role === data.role) {
      return { status: `User is already role: ${data.role}` };
    } else {
      await auth().setCustomUserClaims(user.uid, { role: data.role });
      return { status: 'Success!' };
    }
  } catch (e) {
    if (e instanceof Error) {
      return { status: e.message };
    }
    return { status: JSON.stringify(e) };
  }
});

export default setUserRole;
