import adminFirebase from 'firebase/auth';

export interface Userf {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  role: string;
}

export interface User extends adminFirebase.User {
  role?: string;
  firstName: string;
  lastName: string;
}
