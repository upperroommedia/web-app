import { useContext, createContext, useEffect, useState } from 'react';
import firebase, {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  //   IdTokenResult,
} from 'firebase/auth';
import { userCredentials } from '../types';
import { auth } from '../../firebase/firebase';
import nookies from 'nookies';

interface User extends firebase.User {
  role?: string;
}
interface Context {
  user: User | undefined;
  login: (loginForm: userCredentials) => Promise<any>;
  loginWithGoogle: () => Promise<any>;
  signup: (loginForm: userCredentials) => Promise<any>;
  logoutUser: () => Promise<void>;
}

const UserContext = createContext<Context | null>(null);

export const UserProvider = ({ children }: any) => {
  const [user, setUser] = useState<User>();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).nookies = nookies;
    }
    const unsubscribe = auth.onIdTokenChanged(async (user) => {
      if (!user) {
        setUser(undefined);
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', '', { path: '/' });
      } else {
        const token = await user.getIdToken();
        const role = (await user.getIdTokenResult()).claims.role as string;
        setUser({ ...user, role });
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', token, { path: '/' });
      }
    });
    const handle = setInterval(async () => {
      // eslint-disable-next-line no-console
      console.log(`refreshing token...`);
      const user = auth.currentUser;
      if (user) await user.getIdToken(true);
    }, 10 * 60 * 1000);
    return () => {
      unsubscribe();
      clearInterval(handle);
    };
  }, []);

  // Login User
  const login = async (loginForm: userCredentials) => {
    try {
      await signInWithEmailAndPassword(auth, loginForm.email, loginForm.password);
    } catch (error: any) {
      return error.code;
    }
  };

  const loginWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      return error.code;
    }
  };

  const signup = async (loginForm: userCredentials) => {
    try {
      await createUserWithEmailAndPassword(auth, loginForm.email, loginForm.password);
    } catch (error: any) {
      return error.code;
    }
  };

  const logoutUser = async () => {
    await signOut(auth);
    setUser(undefined);
  };

  return (
    <UserContext.Provider
      value={{
        user,
        login,
        loginWithGoogle,
        signup,
        logoutUser,
      }}
    >
      {children}
    </UserContext.Provider>
  );
};

const useAuth = () => {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useAuth must be within AuthProvider');
  }
  return context;
};

export default useAuth;
