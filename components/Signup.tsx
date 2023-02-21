/**
 * Page for Signing up the User
 */
// React
import { useState } from 'react';
import { useRouter } from 'next/router';

// Auth
import useAuth from '../context/user/UserContext';

// 3rd Party
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';

// Components
import PopUp from './PopUp';
import AuthErrors from './AuthErrors';

import styles from '../styles/SignInWithGoogleButton.module.css';
import Image from 'next/image';
import { SignupForm } from '../context/types';

const Signup = () => {
  const router = useRouter();
  const { signup, loginWithGoogle } = useAuth();

  const [data, setData] = useState<SignupForm>({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSignup = async () => {
    const res = await signup(data);
    const authResult = AuthErrors(res);
    if (authResult.authFailure) {
      setTitle(authResult.title);
      setErrorMessage(authResult.errorMessage);
      setOpen(true);
    }
    router.push(authResult.dest);
  };

  const handleLoginWithGoogle = async () => {
    try {
      await loginWithGoogle();
      router.push('/');
    } catch {
      setTitle('Error');
      setErrorMessage('Something went wrong. Please try again.');
      setOpen(true);
    }
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
      <h1 className="text-center my-3 ">Signup</h1>
      <div style={{ height: '100%', width: '300px', margin: '20px' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSignup();
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <TextField
              fullWidth
              placeholder="Enter First Name"
              required
              onChange={(e: any) =>
                setData({
                  ...data,
                  firstName: e.target.value,
                })
              }
              value={data.firstName}
              size="small"
            />
            <TextField
              fullWidth
              placeholder="Enter Last Name"
              required
              onChange={(e: any) =>
                setData({
                  ...data,
                  lastName: e.target.value,
                })
              }
              value={data.lastName}
              size="small"
            />
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
            onClick={handleSignup}
          >
            SignUp
          </Button>
          <p style={{ textAlign: 'center' }}>or</p>
          <div className={styles.google_btn} onClick={handleLoginWithGoogle}>
            <div className={styles.google_icon_wrapper}>
              <Image src="/google-logo.svg" alt="Google Logo" width={30} height={30} />
            </div>
            <p className={styles.btn_text}>
              <b>Sign in with google</b>
            </p>
          </div>
        </form>
        <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
          {errorMessage}
        </PopUp>
      </div>
    </div>
  );
};

export default Signup;
