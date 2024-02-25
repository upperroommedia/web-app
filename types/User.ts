import adminFirebase from 'firebase/auth';

export const UserRole = {
  ADMIN: 'admin',
  UPLOADER: 'uploader',
  USER: 'user',
  PUBLISHER: 'publisher',
} as const;

export type UserRoleType = (typeof UserRole)[keyof typeof UserRole];
export function canUserRolePublish(role: string | undefined) {
  return role === UserRole.ADMIN || role === UserRole.PUBLISHER;
}

export interface User extends adminFirebase.User {
  role?: UserRoleType;
  firstName: string;
  lastName: string;
  canUpload: () => boolean;
  canPublish: () => boolean;
  isAdmin: () => boolean;
}
