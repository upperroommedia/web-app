import { useContext, createContext, useEffect, useState } from 'react';
import {
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
import { setDoc, doc, getDoc } from 'firebase/firestore';
import firestore from '../../firebase/firestore';
import { User, UserRole } from '../../types/User';
import Stack from '@mui/material/Stack';
import Image from 'next/image';

interface Context {
  user: User | undefined;
  loading: boolean;
  login: (loginForm: userCredentials) => Promise<any>;
  loginWithGoogle: () => Promise<any>;
  signup: (loginForm: SignupForm) => Promise<any>;
  logoutUser: () => Promise<void>;
  resetPassword: (email: string) => Promise<any>;
}

const UserContext = createContext<Context | null>(null);

const getUserInfoFromFirestore = async (uid: string) => {
  const userRef = doc(firestore, 'users', uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    return { firstName: userSnap.data().firstName as string, lastName: userSnap.data().lastName as string };
  }
};

export const UserProvider = ({ children }: any) => {
  const [user, setUser] = useState<User>();
  const [artificalLoading, setArtificalLoading] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).nookies = nookies;
    }
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      setLoading(true);
      console.log('here');
      if (!user) {
        setUser(undefined);
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', '', { path: '/' });
      } else {
        try {
          const token = await user.getIdToken();
          const role = (await user.getIdTokenResult()).claims.role as string;
          const names = await getUserInfoFromFirestore(user.uid);
          setUser({
            ...user,
            ...names!,
            role,
            isAdmin: () => role === UserRole.ADMIN,
            isUploader: () => role === UserRole.UPLOADER || role === UserRole.ADMIN,
          });
          nookies.destroy(null, 'token');
          nookies.set(null, 'token', token, { path: '/' });
          // router.reload();
        } catch (e) {
          return e;
        }
      }
      setLoading(false);
    });

    const timer = setTimeout(() => {
      setArtificalLoading(false);
    }, 500);

    return () => {
      unsubscribe();
      clearTimeout(timer);
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
        await addNewUserToDb(res.user.uid, email, res.user.displayName || '', '');
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
  };

  const resetPassword = async (email: string) => {
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (error: any) {
      return error;
    }
  };

  if (loading || artificalLoading) {
    return (
      <Stack
        sx={{
          width: '100vw',
          height: '100vh',
          // bgcolor: 'rgb(31 41 55)',

          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Image src="/URM_icon.png" alt="Upper Room Media Logo" width={100} height={100} />
      </Stack>
    );
  }

  return (
    <UserContext.Provider
      value={{
        user,
        loading,
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
