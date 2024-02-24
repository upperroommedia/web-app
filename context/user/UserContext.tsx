import { useContext, createContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  //   IdTokenResult,
} from 'firebase/auth';
import auth from '../../firebase/auth';
import { SignupForm, userCredentials } from '../types';
import nookies from 'nookies';
import { User, UserRole, UserRoleType } from '../../types/User';
import Stack from '@mui/material/Stack';
import Image from 'next/image';

interface Context {
  user: User | undefined;
  loading: boolean;
  login: (loginForm: userCredentials) => Promise<any>;
  loginWithGoogle: () => Promise<any>;
  loginWithFacebook: () => Promise<any>;
  loginWithApple: () => Promise<any>;
  signup: (loginForm: SignupForm) => Promise<any>;
  logoutUser: () => Promise<void>;
  resetPassword: (email: string) => Promise<any>;
}

const UserContext = createContext<Context | null>(null);

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
      if (!user) {
        setUser(undefined);
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', '', { path: '/' });
      } else {
        try {
          const token = await user.getIdToken();
          const role = (await user.getIdTokenResult()).claims.role as UserRoleType;
          setUser({
            ...user,
            firstName: user.displayName ?? '',
            lastName: '',
            role,
            isAdmin: () => role === UserRole.ADMIN,
            canUpload: () => role === UserRole.UPLOADER || role === UserRole.ADMIN || role === UserRole.PUBLISHER,
            canPublish: () => role === UserRole.ADMIN || role === UserRole.PUBLISHER,
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

  const loginWithFacebook = async () => {
    try {
      const provider = new FacebookAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      return error.code;
    }
  };

  const loginWithApple = async () => {
    try {
      const provider = new OAuthProvider('apple.com');
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      return error.code;
    }
  };

  const signup = async (loginForm: SignupForm) => {
    try {
      await createUserWithEmailAndPassword(auth, loginForm.email, loginForm.password);
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
          height: '100dvh',
          // bgcolor: 'rgb(31 41 55)',

          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Image src="/URM_icon.png" alt="Upper Room Media Logo" width={100} height={100} priority />
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
        loginWithFacebook,
        loginWithApple,
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
