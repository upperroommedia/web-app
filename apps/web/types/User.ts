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

export type DirectoryUser = {
  uid: string;
  email: string | null;
  photoURL: string | null;
  displayName: string | null;
  role?: UserRoleType;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  metadata: {
    creationTime?: string;
    lastSignInTime?: string;
    lastRefreshTime?: string | null;
  };
  providerData: Array<{
    uid: string;
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
    providerId: string;
    phoneNumber?: string | null;
  }>;
  refreshToken: string;
  tenantId: string | null;
  phoneNumber: string | null;
  providerId: string;
};

export type DirectoryUserWithLoading = DirectoryUser & {
  loading: boolean;
};
