import { logger } from 'firebase-functions/v2';
import {
  beforeUserCreated,
} from "firebase-functions/v2/identity";


const setUserRoleOnCreate = beforeUserCreated((event) => {
  const defaultRole = 'user';
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
