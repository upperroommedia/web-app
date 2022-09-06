/* eslint-disable import/no-duplicates */
import { useReducer, useEffect, useState } from 'react';
import UserContext from './UserContext';
import userReducer from './UserReducer';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import firebase from 'firebase/auth';
import { auth } from '../../firebase/firebase';
import nookies from 'nookies';

import { GET_USER, SET_LOADING, LOGOUT, userCreditionals } from '../types';

const UserState = (props: any) => {
  const initialState = {
    username: null,
    role: null,
    isAuthenticated: false,
    loading: false,
  };
  const [user, setUser] = useState<firebase.User | null>(null);

  const [state, dispatch] = useReducer(userReducer, initialState);

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
        await dispatch({
          type: GET_USER,
          payload: {
            username: user.email,
            // TODO Role
            role: null,
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
  const login = async (loginForm: userCreditionals) => {
    setLoading();
    try {
      await signInWithEmailAndPassword(
        auth,
        loginForm.email,
        loginForm.password
      );
    } catch (error: any) {
      return error.code;
    }
    await dispatch({
      type: GET_USER,
      payload: {
        username: loginForm.email,
        // TODO Role
        role: null,
      },
    });
  };
  const signup = async (loginForm: userCreditionals) => {
    setLoading();
    try {
      await createUserWithEmailAndPassword(
        auth,
        loginForm.email,
        loginForm.password
      );
    } catch (error: any) {
      return error.code;
    }
    await dispatch({
      type: GET_USER,
      payload: {
        username: loginForm.email,
        // TODO Role
        role: null,
      },
    });
  };

  const logoutUser = async () => {
    await signOut(auth);
    setUser(null);
    dispatch({ dispatch: LOGOUT });
  };

  return (
    <UserContext.Provider
      value={{
        username: state.username,
        user: user,
        isAuthenticated: state.isAuthenticated,
        loading: state.loading,
        role: state.role,
        login,
        signup,
        logoutUser,
      }}
    >
      {props.children}
    </UserContext.Provider>
  );
};

export default UserState;
