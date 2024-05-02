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

export const ROLES = ['user', 'admin', 'uploader', 'publisher'];
export type Order = 'asc' | 'desc';

export type UploaderFieldError = { error: boolean; message: string; initialState: boolean };
export type UploadProgress = { error: boolean; percent: number; message: string };
