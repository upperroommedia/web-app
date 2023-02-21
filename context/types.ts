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

export const ROLES = ['user', 'admin', 'uploader'];
export type Order = 'asc' | 'desc';
