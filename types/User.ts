import adminFirebase from 'firebase/auth';

export const UserRole = {
  ADMIN: 'admin',
  UPLOADER: 'uploader',
  USER: 'user',
  PUBLISHER: 'publisher',
} as const;

export type UserRoleType = (typeof UserRole)[keyof typeof UserRole];

export const isUserRoleAdmin = (role: UserRoleType) => role === UserRole.ADMIN;
export const canUserRoleUpload = (role: UserRoleType) =>
  role === UserRole.UPLOADER || role === UserRole.ADMIN || role === UserRole.PUBLISHER;
export const canUserRolePublish = (role: UserRoleType) => role === UserRole.ADMIN || role === UserRole.PUBLISHER;

export interface User extends adminFirebase.User {
  role?: UserRoleType;
  firstName: string;
  lastName: string;
  canUpload: () => boolean;
  canPublish: () => boolean;
  isAdmin: () => boolean;
}

export type UserWithLoading = User & {
  loading: boolean;
};
