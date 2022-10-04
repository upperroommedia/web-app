export const SET_LOADING = 'SET_LOADING';
export const LOGOUT = 'LOGOUT';

// User Context
export const GET_USER = 'GET_USER';

export interface userCredentials {
  email: string;
  password: string;
}

export interface AuthState {
  username: string | null;
  role: string | null;
  isAuthenticated: boolean;
  loading: boolean;
}