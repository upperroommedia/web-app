import { logger } from 'firebase-functions/v2';
import {
  beforeUserCreated,
} from "firebase-functions/v2/identity";


const setUserRoleOnCreate = beforeUserCreated((event) => {
  // In development/emulator mode, default to 'admin' role for easier testing
  // In production, default to 'user' role for security
  const defaultRole = process.env.FUNCTIONS_EMULATOR === 'true' ? 'admin' : 'user';
  logger.info(`Setting customClaims role:${defaultRole} for: ${event.data?.displayName}`, { event: event });
  // Return the custom claims to be set on the user
  // This will be merged with the user's existing data
  return {
    customClaims: {
      role: defaultRole
    }
  };
})

export default setUserRoleOnCreate;
