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

export const ROLES = ['user', 'admin', 'uploader'];
