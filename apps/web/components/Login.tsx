// import Button from '@mui/material/Button';
// import TextField from '@mui/material/TextField';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import useAuth from '../context/user/UserContext';
import PopUp from './PopUp';
// import Alert from '@mui/material/Alert';
// import Collapse from '@mui/material/Collapse';
import { GoogleLoginButton, AppleLoginButton, MicrosoftLoginButton } from 'react-social-login-buttons';
import { AuthErrorCodes, AuthError, UserCredential, getAdditionalUserInfo } from 'firebase/auth';
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD, isDevelopment } from '../context/user/devAuth';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { resolveAuthCallbackDestination } from '../utils/authRedirect';

const INVITE_CLAIM_AUTH_META_KEY = 'invite-claim-auth-meta';
const INVITE_LOGIN_NOTICE_KEY = 'invite-claim-login-notice';

const Login = () => {
  const router = useRouter();
  const { user, loading, loginWithGoogle, loginWithApple, loginWithMicrosoft, login } = useAuth();
  const [devLoginLoading, setDevLoginLoading] = useState(false);
  const [providerLoginLoading, setProviderLoginLoading] = useState<string | null>(null);

  // const [data, setData] = useState({
  //   email: '',
  //   password: '',
  // });
  const [open, setOpen] = useState<boolean>(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [inviteNotice, setInviteNotice] = useState('');
  const [inviteNoticeOpen, setInviteNoticeOpen] = useState(false);

  // const [forgotPasswordPopup, setForgotPasswordPopup] = useState<boolean>(false);
  // const [forgotPasswordEmail, setForgotPasswordEmail] = useState<string>('');
  // const [sentForgotPasswordEmail, setSentForgotPasswordEmail] = useState<string>('');
  // const [forgotPasswordLinkSent, setForgotPasswordLinkSent] = useState<boolean>(false);

  // const handleForgotPassword = async (e: React.FormEvent<HTMLFormElement>) => {
  //   e.preventDefault();
  //   try {
  //     const { callbackurl } = router.query;
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
  //   const { callbackurl } = router.query;
  //   const authResult = AuthErrors(res, (callbackurl as string) || '/');
  //   if (authResult.authFailure) {
  //     setTitle(authResult.title);
  //     setErrorMessage(authResult.errorMessage);
  //     setOpen(true);
  //   }
  //   router.push(authResult.dest);
  // };
  // Type guard function
  function isAuthError(error: unknown): error is AuthError {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: unknown; message?: unknown };
    return (
      typeof candidate.code === 'string' &&
      candidate.code.startsWith('auth/') &&
      typeof candidate.message === 'string'
    );
  }

  const getCallbackDestination = () => {
    return resolveAuthCallbackDestination(router.query.callbackurl, router.query.callbackUrl);
  };

  useEffect(() => {
    if (!router.isReady || typeof window === 'undefined') {
      return;
    }
    const notice = sessionStorage.getItem(INVITE_LOGIN_NOTICE_KEY);
    if (!notice) {
      return;
    }
    sessionStorage.removeItem(INVITE_LOGIN_NOTICE_KEY);
    setInviteNotice(notice);
    setInviteNoticeOpen(true);
  }, [router.isReady]);

  useEffect(() => {
    if (!router.isReady || loading || !user) {
      return;
    }

    const callbackDestination = resolveAuthCallbackDestination(router.query.callbackurl, router.query.callbackUrl);
    void router.replace(callbackDestination);
  }, [loading, router, router.isReady, router.query.callbackurl, router.query.callbackUrl, user]);

  const handleLogin = async (providerName: string, loginFunction: () => Promise<UserCredential | null>) => {
    if (providerLoginLoading) {
      return;
    }

    setProviderLoginLoading(providerName);
    let credential: UserCredential | null = null;
    try {
      credential = await loginFunction();
      if (!credential) {
        return;
      }

      const callbackDestination = getCallbackDestination();
      if (callbackDestination.startsWith('/invite/claim')) {
        const additionalInfo = getAdditionalUserInfo(credential);
        if (typeof window !== 'undefined') {
          sessionStorage.setItem(
            INVITE_CLAIM_AUTH_META_KEY,
            JSON.stringify({
              uid: credential.user.uid ?? null,
              email: credential.user.email ?? null,
              isNewUser: additionalInfo?.isNewUser === true,
              providerId: additionalInfo?.providerId ?? null,
              capturedAtMs: Date.now(),
            })
          );
        }
      } else if (typeof window !== 'undefined') {
        sessionStorage.removeItem(INVITE_CLAIM_AUTH_META_KEY);
      }

      // Success - redirect user
      await router.push(callbackDestination);
      return;
    } catch (error) {
      if (isAuthError(error)) {
        if (error.code === AuthErrorCodes.CREDENTIAL_ALREADY_IN_USE || error.code === AuthErrorCodes.NEED_CONFIRMATION) {
          setTitle('Account Exists With Different Credential');
          setErrorMessage('This email is already associated with another sign-in method. Please sign in with your existing provider.');
          setOpen(true);
          return;
        } else if (error.code === 'auth/requires-existing-provider-signin') {
          setTitle('Account Linking Required');
          setErrorMessage('This email is already associated with another sign-in method. Please sign in with your existing provider first, then try linking Microsoft from your profile.');
          setOpen(true);
          return;
        } else if (
          error.code === AuthErrorCodes.POPUP_CLOSED_BY_USER ||
          error.code === AuthErrorCodes.USER_CANCELLED ||
          error.code === AuthErrorCodes.EXPIRED_POPUP_REQUEST ||
          error.code === 'auth/cancelled-popup-request'
        ) {
          return;
        } else if (error.code === AuthErrorCodes.POPUP_BLOCKED) {
          setTitle('Popup Blocked');
          setErrorMessage('Your browser blocked the authentication popup. Please allow popups for this site and try again.');
          setOpen(true);
          return;
        }

        setTitle('Authentication Error');
        setErrorMessage(error.message);
        setOpen(true);
        return;
      }

      setTitle('Authentication Error');
      setErrorMessage('Something went wrong. Please try again or contact support.');
      setOpen(true);
      return;
    } finally {
      setProviderLoginLoading(null);
    }
  };

  const authActionDisabled = providerLoginLoading !== null || devLoginLoading;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-around',
        alignItems: 'center',
      }}
    >
      {/* <form
        onSubmit={(e) => {
          e.preventDefault();
          handleLogin();
        }}
      > */}
      <div style={{ height: '100%', width: '300px', margin: '20px' }}>
        {/* <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {user?.emailVerified === false && (
              <Alert severity="info" style={{ marginBottom: '1em' }}>
                An account verification email has been sent to {user.email}. Please click the link in the email and then
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
        <div style={{ pointerEvents: authActionDisabled ? 'none' : 'auto', opacity: authActionDisabled ? 0.7 : 1 }}>
          <GoogleLoginButton onClick={() => handleLogin('google', loginWithGoogle)} />
          <MicrosoftLoginButton onClick={() => handleLogin('microsoft', loginWithMicrosoft)} />
          <AppleLoginButton onClick={() => handleLogin('apple', loginWithApple)} />
        </div>
        
        {isDevelopment && (
          <>
            <div style={{ 
              borderTop: '1px solid #ccc', 
              margin: '20px 0', 
              paddingTop: '20px',
              textAlign: 'center'
            }}>
              <p style={{ color: '#666', fontSize: '12px', marginBottom: '10px' }}>
                Development Mode Only
              </p>
              <Button
                variant="contained"
                color="warning"
                fullWidth
                disabled={devLoginLoading}
                onClick={async () => {
                  setDevLoginLoading(true);
                  try {
                    const result = await login({ email: DEV_ADMIN_EMAIL, password: DEV_ADMIN_PASSWORD });
                    if (result) {
                      // Error code returned
                      setTitle('Dev Login Error');
                      setErrorMessage(`Error: ${result}. Make sure to run: pnpm run create-dev-admin`);
                      setOpen(true);
                    } else {
                      // Success - redirect
                      router.push(getCallbackDestination());
                    }
                  } catch (e: unknown) {
                    const message = e instanceof Error ? e.message : 'Unknown error';
                    setTitle('Dev Login Error');
                    setErrorMessage(message);
                    setOpen(true);
                  } finally {
                    setDevLoginLoading(false);
                  }
                }}
              >
                {devLoginLoading ? 'Logging in...' : '🔧 Dev Login (Admin)'}
              </Button>
            </div>
          </>
        )}
      </div>
      {/* </form> */}
      {/* <PopUp open={forgotPasswordPopup} title="Forgot Password" setOpen={setForgotPasswordPopup}>
        <div className="form">
          <h1 className="form-title">Forgot Password?</h1>
          <form style={{ display: 'grid' }} onSubmit={async (e) => await handleForgotPassword(e)}>
            <TextField
              onChange={(e) => setForgotPasswordEmail(e.target.value)}
              value={forgotPasswordEmail}
              placeholder="Email"
              type="email"
            />
            <Button className="submit-button" type="submit">
              Send Password Reset
            </Button>
          </form>
        </div>
      </PopUp> */}
      <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
        {errorMessage}
      </PopUp>
      <Snackbar
        open={inviteNoticeOpen}
        autoHideDuration={9000}
        onClose={() => setInviteNoticeOpen(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert onClose={() => setInviteNoticeOpen(false)} severity="warning" variant="filled" sx={{ width: '100%' }}>
          {inviteNotice}
        </Alert>
      </Snackbar>
    </div>
  );
};

export default Login;
