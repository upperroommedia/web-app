/* eslint-disable import/no-duplicates */
import { useReducer, useEffect, useState, Reducer } from 'react';
import userContext from './userContext';
import userReducer from './UserReducer';
import {
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebase from 'firebase/auth';
import { auth } from '../../firebase/firebase';
import nookies from 'nookies';

import {
  GET_USER,
  SET_LOADING,
  LOGOUT,
  userCredentials,
  AuthState,
} from '../types';
import { setDoc, doc, getFirestore, getDoc } from 'firebase/firestore';
import { firebase as projectFirebase } from '../../firebase/firebase';

const UserState = (props: any) => {
  const db = getFirestore(projectFirebase);
  const initialState: AuthState = {
    username: null,
    role: null,
    isAuthenticated: false,
    loading: false,
  };
  const [user, setUser] = useState<firebase.User | null>(null);

  const [state, dispatch] = useReducer<Reducer<AuthState, any>>(
    userReducer,
    initialState
  );

  const addUserToDb = async (uid: string, email: string, role: string) => {
    await setDoc(doc(db, 'users', uid), {
      uid,
      email,
      role,
    });
  };

  const fetchUserFromDb = async (uid: string) => {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    return userSnap.data();
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).nookies = nookies;
    }
    return auth.onIdTokenChanged(async (user) => {
      if (!user) {
        setUser(null);
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', '', { path: '/' });
        dispatch({ dispatch: LOGOUT });
      } else {
        const token = await user.getIdToken();
        setUser(user);
        nookies.destroy(null, 'token');
        nookies.set(null, 'token', token, { path: '/' });
        dispatch({
          type: GET_USER,
          payload: {
            username: user.email,
            role: state.role,
          },
        });
      }
    });
  }, []);

  useEffect(() => {
    const handle = setInterval(async () => {
      // eslint-disable-next-line no-console
      console.log(`refreshing token...`);
      const user = auth.currentUser;
      if (user) await user.getIdToken(true);
    }, 10 * 60 * 1000);
    return () => clearInterval(handle);
  }, []);

  // Trigger loading state
  const setLoading = () => {
    dispatch({ type: SET_LOADING });
  };

  // Login User
  const login = async (loginForm: userCredentials) => {
    setLoading();
    try {
      await signInWithEmailAndPassword(
        auth,
        loginForm.email,
        loginForm.password
      ).then(async (res) => {
        const user = await fetchUserFromDb(res.user.uid);
        dispatch({
          type: GET_USER,
          payload: {
            username: loginForm.email,
            role: user?.role,
          },
        });
      });
    } catch (error: any) {
      return error.code;
    }
  };

  const loginWithGoogle = async () => {
    setLoading();
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider).then(async (res) => {
        const details = getAdditionalUserInfo(res);
        if (res.user.email !== null && details?.isNewUser) {
          await addUserToDb(res.user.uid, res.user.email, 'user');
          dispatch({
            type: GET_USER,
            payload: {
              username: res.user.email,
              role: 'user',
            },
          });
        } else if (res.user.email !== null && !details?.isNewUser) {
          const user = await fetchUserFromDb(res.user.uid);
          dispatch({
            type: GET_USER,
            payload: {
              username: res.user.email,
              role: user?.role,
            },
          });
        }
      });
    } catch (error: any) {
      return error.code;
    }
  };

  const signup = async (loginForm: userCredentials) => {
    setLoading();
    try {
      await createUserWithEmailAndPassword(
        auth,
        loginForm.email,
        loginForm.password
      ).then(
        async (res) => await addUserToDb(res.user.uid, loginForm.email, 'user')
      );
    } catch (error: any) {
      return error.code;
    }
    dispatch({
      type: GET_USER,
      payload: {
        username: loginForm.email,
        role: 'user',
      },
    });
  };

  const logoutUser = async () => {
    await signOut(auth);
    setUser(null);
    dispatch({
      type: LOGOUT,
    });
  };

  return (
    <userContext.Provider
      value={{
        user: { ...user, ...state },
        login,
        loginWithGoogle,
        signup,
        logoutUser,
      }}
    >
      {props.children}
    </userContext.Provider>
  );
};

export default UserState;
