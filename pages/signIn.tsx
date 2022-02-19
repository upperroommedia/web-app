import type { NextPage } from 'next';
import StyledFirebaseAuth from 'react-firebaseui/StyledFirebaseAuth';
import firebase from '../firebase/firebase';
import { getAuth, EmailAuthProvider, GoogleAuthProvider } from 'firebase/auth';
import styles from '../styles/SignIn.module.css';
const auth = getAuth(firebase);

const uiConfig = {
  signInSuccessUrl: '/',
  signInOptions: [
    EmailAuthProvider.PROVIDER_ID,
    GoogleAuthProvider.PROVIDER_ID,
    // firebase.auth.FacebookAuthProvider.PROVIDER_ID,
  ],
};

const SignInScreen: NextPage = () => {
  return (
    <div className={`${styles.container} ${styles.center}`}>
      <h1 className={styles.header}>Welcome to Upper Room Media</h1>
      <StyledFirebaseAuth uiConfig={uiConfig} firebaseAuth={auth} />
    </div>
  );
};

export default SignInScreen;
