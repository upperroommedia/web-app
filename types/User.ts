import adminFirebase from 'firebase/auth';

export interface User extends adminFirebase.User {
  role?: string;
  firstName: string;
  lastName: string;
  isUploader: () => boolean;
  isAdmin: () => boolean;
}

export const UserRole = {
  ADMIN: 'admin',
  UPLOADER: 'uploader',
  USER: 'user',
};
