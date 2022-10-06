/**
 * Page for Logging in the User
 */
// React
import { useState } from 'react';

// Next
import type { GetServerSideProps, InferGetServerSidePropsType, GetServerSidePropsContext } from 'next';
import { useRouter } from 'next/router';

// 3rd Party Components
import { Button, TextField } from '@mui/material';

// Auth
import useAuth from '../context/user/UserContext';

// Components
import ProtectedRoute from '../components/ProtectedRoute';
import AuthErrors from '../components/AuthErrors';
import PopUp from '../components/PopUp';

import styles from '../styles/SignInWithGoogleButton.module.css';
import Image from 'next/image';

const Login = (props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const router = useRouter();
  const { login, loginWithGoogle } = useAuth();

  const [data, setData] = useState({
    email: '',
    password: '',
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleLogin = async () => {
    const res = await login(data);

    const authResult = AuthErrors(res);
    if (authResult.authFailure) {
      setTitle(authResult.title);
      setErrorMessage(authResult.errorMessage);
      setOpen(true);
    }
    router.push(authResult.dest);
  };

  const handleLoginWithGoogle = async () => {
    await loginWithGoogle().then(() => router.push('/'));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-around',
        alignItems: 'center',
      }}
    >
      <h1 className="text-center my-3 ">Login</h1>
      <div style={{ height: '100%', width: '300px', margin: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <TextField
            fullWidth
            type="email"
            placeholder="Enter email"
            required
            onChange={(e: any) =>
              setData({
                ...data,
                email: e.target.value,
              })
            }
            value={data.email}
            size="small"
          />
          <TextField
            fullWidth
            type="password"
            placeholder="Password"
            required
            onChange={(e: any) =>
              setData({
                ...data,
                password: e.target.value,
              })
            }
            value={data.password}
            size="small"
          />
        </div>
        <Button
          fullWidth
          variant="contained"
          type="submit"
          style={{ marginTop: '30px' }}
          size="medium"
          onClick={handleLogin}
        >
          Login
        </Button>
        <p style={{ textAlign: 'center' }}>or</p>
        <div className={styles.google_btn} onClick={handleLoginWithGoogle}>
          <div className={styles.google_icon_wrapper}>
            <div className={styles.google_icon}>
              <Image src="/google-logo.svg" width="30px" height="30px" />
            </div>
          </div>
          <p className={styles.btn_text}>
            <b>Sign in with google</b>
          </p>
        </div>
      </div>
      <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
        {errorMessage}
      </PopUp>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.token) {
    return { props: {} };
  }
  return {
    redirect: {
      permanent: false,
      destination: '/',
    },
    props: {},
  };
};

export default Login;
