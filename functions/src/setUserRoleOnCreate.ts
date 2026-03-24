import { logger } from 'firebase-functions/v2';
import {
  beforeUserCreated,
  beforeUserSignedIn,
} from "firebase-functions/v2/identity";

const ADMIN_ROLE = 'admin';
const DEFAULT_ROLE = 'user';
const STAGING_PROJECT_ID = 'urm-app-staging';
const DEFAULT_STAGING_ADMIN_EMAILS = ['youssef.a.asaad@gmail.com'];

const normalizeEmail = (email: string | null | undefined): string => email?.trim().toLowerCase() ?? '';

const getProjectId = (): string =>
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || '';

const isStagingProject = (): boolean => getProjectId() === STAGING_PROJECT_ID;

const getAlwaysAdminEmails = (): Set<string> => {
  const configured = (process.env.ALWAYS_ADMIN_EMAILS || '')
    .split(',')
    .map((value) => normalizeEmail(value))
    .filter(Boolean);

  return new Set([...DEFAULT_STAGING_ADMIN_EMAILS, ...configured].map((value) => normalizeEmail(value)));
};

const shouldForceAdminRole = (email: string | null | undefined): boolean => {
  if (!isStagingProject()) return false;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  return getAlwaysAdminEmails().has(normalizedEmail);
};

const resolveRoleForUser = (email: string | null | undefined): string =>
  shouldForceAdminRole(email) ? ADMIN_ROLE : DEFAULT_ROLE;

const setUserRoleOnCreate = beforeUserCreated((event) => {
  const email = event.data?.email;
  const role = resolveRoleForUser(email);
  logger.info('Setting user role on create', {
    email,
    role,
    projectId: getProjectId(),
  });
  // Return the custom claims to be set on the user
  // This will be merged with the user's existing data
  return {
    customClaims: {
      role,
    }
  };
});

const setUserRoleOnSignIn = beforeUserSignedIn((event) => {
  const email = event.data?.email;
  if (!shouldForceAdminRole(email)) {
    return;
  }

  logger.info('Ensuring staging admin role on sign-in', {
    email,
    role: ADMIN_ROLE,
    projectId: getProjectId(),
  });

  return {
    customClaims: {
      role: ADMIN_ROLE,
    },
  };
});

export default setUserRoleOnCreate;
export { setUserRoleOnSignIn };
