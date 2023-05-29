// import Button from '@mui/material/Button';
// import TextField from '@mui/material/TextField';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
// import AuthErrors from './AuthErrors';
import PopUp from '../../../components/PopUp';
// import Alert from '@mui/material/Alert';
// import Collapse from '@mui/material/Collapse';

import GoogleSignIn from '../GoogleSignIn';
import RedirectingComponent from '../RedirectingComponent';

const Login = () => {
  // const searchParams = useSearchParams();

  // const [data, setData] = useState({
  //   email: '',
  //   password: '',
  // });
  // const [open, setOpen] = useState<boolean>(false);
  // const [title, setTitle] = useState('');
  // const [errorMessage, setErrorMessage] = useState('');

  const [forgotPasswordPopup, setForgotPasswordPopup] = useState<boolean>(false);
  // const [forgotPasswordEmail, setForgotPasswordEmail] = useState<string>('');
  // const [sentForgotPasswordEmail, setSentForgotPasswordEmail] = useState<string>('');
  // const [forgotPasswordLinkSent, setForgotPasswordLinkSent] = useState<boolean>(false);

  const params = useSearchParams();
  const [hasLogged, setHasLogged] = useState(false);
  // const { tenant } = useAuth();

  // const handleForgotPassword = async (e: React.FormEvent<HTMLFormElement>) => {
  //   e.preventDefault();
  //   try {
  //     const callbackurl = searchParams?.get('callbackurl');
  //     const res = await resetPassword(forgotPasswordEmail);
  //     const authResult = AuthErrors(res, (callbackurl as string) || '/');
  //     if (authResult.authFailure) {
  //       setTitle(authResult.title);
  //       setErrorMessage(authResult.errorMessage);
  //       setOpen(true);
  //     } else {
  //       setSentForgotPasswordEmail(forgotPasswordEmail);
  //       setForgotPasswordPopup(false);
  //       setForgotPasswordLinkSent(true);
  //     }
  //   } catch (e) {
  //     alert('There was an error, try again');
  //   }
  // };

  // const handleLogin = async () => {
  //   const res = await login(data);
  //   const callbackurl = searchParams?.get('callbackurl');
  //   const authResult = AuthErrors(res, (callbackurl as string) || '/');
  //   if (authResult.authFailure) {
  //     setTitle(authResult.title);
  //     setErrorMessage(authResult.errorMessage);
  //     setOpen(true);
  //   }
  //   router.push(authResult.dest);
  // };

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // handleLogin();
          }}
        >
          <div style={{ height: '100%', width: '300px', margin: '20px' }}>
            {/* <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {tenant?.emailVerified === false && (
              <Alert severity="info" style={{ marginBottom: '1em' }}>
                An account verification email has been sent to {tenant.email}. Please click the link in the email and then
                login using your new account (may be in spam)
              </Alert>
            )}
            <Collapse in={forgotPasswordLinkSent}>
              <Alert severity="info" style={{ marginBottom: '1em' }}>
                A password reset email has been sent to {sentForgotPasswordEmail} (may be in spam)
              </Alert>
            </Collapse>
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
          <Button fullWidth variant="contained" type="submit" style={{ marginTop: '30px' }} size="medium">
            Login
          </Button>
          <Button
            onClick={() => {
              setForgotPasswordPopup(true);
            }}
          >
            Forgot Password?
          </Button> 
             <p style={{ textAlign: 'center' }}>or</p> */}
            <GoogleSignIn setHasLogged={setHasLogged} redirect={params?.get('redirect')} />
          </div>
        </form>
      ) : (
        <RedirectingComponent path={params?.get('redirect') || '/'} />
      )}
      <PopUp open={forgotPasswordPopup} title="Forgot Password" setOpen={setForgotPasswordPopup}>
        <div className="form">
          <h1 className="form-title">Forgot Password?</h1>
          {/* <form style={{ display: 'grid' }} onSubmit={async (e) => await handleForgotPassword(e)}>
            <TextField
              onChange={(e) => setForgotPasswordEmail(e.target.value)}
              value={forgotPasswordEmail}
              placeholder="Email"
              type="email"
            />
            <Button className="submit-button" type="submit">
              Send Password Reset
            </Button>
          </form> */}
        </div>
      </PopUp>
      {/* <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
        {errorMessage}
      </PopUp> */}
    </div>
  );
};

export default Login;
