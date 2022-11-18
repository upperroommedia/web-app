import { useContext, createContext, useEffect, useState } from 'react';
import adminFirebase, {
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  //   IdTokenResult,
} from 'firebase/auth';
import auth from '../../firebase/auth';
import { SignupForm, userCredentials } from '../types';
import nookies from 'nookies';
import { setDoc, doc } from 'firebase/firestore';
import firestore from '../../firebase/firestore';

interface User extends adminFirebase.User {
  role?: string;
}
interface Context {
  user: User | undefined;
  login: (loginForm: userCredentials) => Promise<any>;
  loginWithGoogle: () => Promise<any>;
  signup: (loginForm: SignupForm) => Promise<any>;
  logoutUser: () => Promise<void>;
  resetPassword: (email: string) => Promise<any>;
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
        try {
          const token = await user.getIdToken();
          const role = (await user.getIdTokenResult()).claims.role as string;
          setUser({ ...user, role });
          nookies.destroy(null, 'token');
          nookies.set(null, 'token', token, { path: '/' });
        } catch (e) {
          return e;
        }
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

  const addNewUserToDb = async (uid: string, email: string, firstName: string, lastName: string) => {
    await setDoc(doc(firestore, 'users', uid), { firstName, lastName, email, uid });
  };

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
      const res = await signInWithPopup(auth, provider);
      const details = getAdditionalUserInfo(res);
      const email = res.user.email;
      if (details?.isNewUser && email) {
        await addNewUserToDb(res.user.uid, email, res.user.displayName, '');
      }
    } catch (error: any) {
      return error.code;
    }
  };

  const signup = async (loginForm: SignupForm) => {
    try {
      const res = await createUserWithEmailAndPassword(auth, loginForm.email, loginForm.password);
      await addNewUserToDb(res.user.uid, loginForm.email, loginForm.firstName, loginForm.lastName);
    } catch (error: any) {
      return error.code;
    }
  };

  const logoutUser = async () => {
    await signOut(auth);
    setUser(undefined);
  };

  const resetPassword = async (email: string) => {
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (error: any) {
      return error;
    }
  };

  return (
    <UserContext.Provider
      value={{
        user,
        login,
        loginWithGoogle,
        signup,
        logoutUser,
        resetPassword,
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
