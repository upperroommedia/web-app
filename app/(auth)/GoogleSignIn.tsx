import Image from 'next/image';
import styles from '../../styles/SignInWithGoogleButton.module.css';
import { useLoadingCallback } from 'react-loading-hook';
import auth from '../../firebase/auth';
import { addNewUserToDb, getGoogleProvider, loginWithProvider } from './firebase';
import { useRouter } from 'next/navigation';
import { Dispatch, SetStateAction } from 'react';

type GoogleSignInParams = {
  setHasLogged: Dispatch<SetStateAction<boolean>>;
  redirect: string | null;
};

export default function GoogleSignIn({ setHasLogged, redirect }: GoogleSignInParams) {
  const router = useRouter();
  const [handleLoginWithGoogle, _isLoading] = useLoadingCallback(async () => {
    setHasLogged(false);
    const { GoogleAuthProvider } = await import('../../firebase/auth');
    const tenant = await loginWithProvider(auth, await getGoogleProvider(auth), GoogleAuthProvider.credentialFromError);
    const names = tenant.name?.split(' ');
    const firstName = names?.shift() ?? '';
    const lastName = names?.join(' ') ?? '';
    addNewUserToDb(tenant.id, tenant.email ?? '', firstName, lastName);
    await fetch('/api/login', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenant.idToken}`,
      },
    });
    setHasLogged(true);
    router.push(redirect ?? '/');
  });

  return (
    <div className={styles.google_btn} onClick={handleLoginWithGoogle}>
      <div className={styles.google_icon_wrapper}>
        <Image src="/google-logo.svg" alt="Google Logo" width={30} height={30} />
      </div>
      <p className={styles.btn_text}>
        <b>Sign in with google</b>
      </p>
    </div>
  );
}
