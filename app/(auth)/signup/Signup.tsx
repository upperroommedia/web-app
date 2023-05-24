/**
 * Page for Signing up the User
 */
// React
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
// 3rd Party
// import Button from '@mui/material/Button';
// import TextField from '@mui/material/TextField';

// Components
import PopUp from '../../../components/PopUp';
import AuthErrors from '../../../components/AuthErrors';

import { SignupForm } from '../../../context/types';
import GoogleSignIn from '../GoogleSignIn';
import auth, { createUserWithEmailAndPassword } from '../../../firebase/auth';
import { addNewUserToDb } from '../firebase';
import RedirectingComponent from '../RedirectingComponent';

const Signup = () => {
  const router = useRouter();
  const params = useSearchParams();
  const [hasLogged, setHasLogged] = useState(false);
  const [data, _setData] = useState<SignupForm>({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const signupWithEmailAndPassword = async (loginForm: SignupForm) => {
    try {
      const res = await createUserWithEmailAndPassword(auth, loginForm.email, loginForm.password);
      await addNewUserToDb(res.user.uid, loginForm.email, loginForm.firstName, loginForm.lastName);
    } catch (error: any) {
      return error.code;
    }
  };

  const handleSignup = async () => {
    const res = await signupWithEmailAndPassword(data);
    const authResult = AuthErrors(res, params?.get('callbackurl') || '/');
    if (authResult.authFailure) {
      setTitle(authResult.title);
      setErrorMessage(authResult.errorMessage);
      setOpen(true);
    } else {
      router.push(authResult.dest);
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
      {!hasLogged ? (
        <>
          <h1 className="text-center my-3 ">Signup</h1>
          <div style={{ height: '100%', width: '300px', margin: '20px' }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSignup();
              }}
            >
              {/* <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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
              <p style={{ textAlign: 'center' }}>or</p> */}
              <GoogleSignIn setHasLogged={setHasLogged} redirect={params?.get('redirect')} />
            </form>
            <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
              {errorMessage}
            </PopUp>
          </div>
        </>
      ) : (
        <RedirectingComponent path={params?.get('redirect') || '/'} />
      )}
    </div>
  );
};

export default Signup;
