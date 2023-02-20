export interface userCredentials {
  email: string;
  password: string;
}

export interface SignupForm {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}
export type CustomClaims = { [key: string]: any };

export interface User {
  id: string;
  name: string | null;
  email: string | null;
  photoUrl: string | null;
  emailVerified: boolean;
  isAnonymous: boolean;
  customClaims: CustomClaims;
}

export const ROLES = ['user', 'admin', 'uploader'];
