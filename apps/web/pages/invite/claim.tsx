import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/router';
import useAuth from '../../context/user/UserContext';
import auth from '../../firebase/auth';
import { ClaimInviteInputType, ClaimInviteResultData, InviteRoleType } from '@upperroom/contracts/invites/inviteTypes';
import { createFunctionV2 } from '../../utils/createFunction';

type ClaimInviteOutputType = { status: 'success'; data: ClaimInviteResultData } | { status: 'error'; error: string };
type ClaimStatus = 'idle' | 'loading' | 'redirecting' | 'claiming' | 'error';
const CLAIM_REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_TIMEOUT_MS = 12_000;
const AUTH_LOADING_TIMEOUT_MS = 15_000;
const REDIRECT_TIMEOUT_MS = 10_000;
const INVITE_CLAIM_AUTH_META_KEY = 'invite-claim-auth-meta';
const INVITE_LOGIN_NOTICE_KEY = 'invite-claim-login-notice';

const readToken = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return (value[0] ?? '').trim();
  }
  return (value ?? '').trim();
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

type InviteClaimAuthMeta = {
  uid: string | null;
  email: string | null;
  isNewUser: boolean;
  providerId: string | null;
  capturedAtMs: number;
};

const readInviteClaimAuthMeta = (): InviteClaimAuthMeta | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = sessionStorage.getItem(INVITE_CLAIM_AUTH_META_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InviteClaimAuthMeta>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      uid: typeof parsed.uid === 'string' ? parsed.uid : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      isNewUser: parsed.isNewUser === true,
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : null,
      capturedAtMs: typeof parsed.capturedAtMs === 'number' ? parsed.capturedAtMs : Date.now(),
    };
  } catch (_error) {
    return null;
  }
};

const clearInviteClaimAuthMeta = (): void => {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(INVITE_CLAIM_AUTH_META_KEY);
  }
};

const getPostClaimDestination = (role: InviteRoleType): string => {
  return role === 'admin' || role === 'publisher' ? '/admin/sermons' : '/';
};

const setInviteLoginNotice = (message: string): void => {
  if (typeof window !== 'undefined') {
    sessionStorage.setItem(INVITE_LOGIN_NOTICE_KEY, message);
  }
};

const InviteClaimPage = () => {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<ClaimStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const attemptedTokenRef = useRef<string | null>(null);
  const authRedirectStartedRef = useRef(false);
  const authLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const signedInEmail = user?.email ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (authLoadingTimeoutRef.current) {
        clearTimeout(authLoadingTimeoutRef.current);
        authLoadingTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!router.isReady) {
      return;
    }

    const token = readToken(router.query.token);
    if (!token) {
      setStatus('error');
      setErrorMessage('Invite token is missing. Please request a new invite link from an admin.');
      return;
    }

    if (loading) {
      if (attemptedTokenRef.current === token) {
        return;
      }
      setStatus('loading');
      if (authLoadingTimeoutRef.current) {
        clearTimeout(authLoadingTimeoutRef.current);
      }
      authLoadingTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) {
          return;
        }
        setStatus('error');
        setErrorMessage('Authentication is taking too long to initialize. Please retry sign-in and claim again.');
      }, AUTH_LOADING_TIMEOUT_MS);
      return;
    }

    if (authLoadingTimeoutRef.current) {
      clearTimeout(authLoadingTimeoutRef.current);
      authLoadingTimeoutRef.current = null;
    }

    if (!user) {
      setStatus('redirecting');
      if (!authRedirectStartedRef.current) {
        authRedirectStartedRef.current = true;
        const callbackPath = `/invite/claim?token=${encodeURIComponent(token)}`;
        router.replace(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
      }
      return;
    }

    if (attemptedTokenRef.current === token) {
      return;
    }

    attemptedTokenRef.current = token;

    const claimInvite = async () => {
      setStatus('claiming');
      setErrorMessage('');

      try {
        const claimInviteCallable = createFunctionV2<ClaimInviteInputType, ClaimInviteOutputType>('claiminvite');
        const result = await withTimeout(
          claimInviteCallable({ token }),
          CLAIM_REQUEST_TIMEOUT_MS,
          'Invite processing timed out. The server did not respond in time.'
        );

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        const firebaseUser = auth.currentUser;
        if (!firebaseUser) {
          throw new Error('Authentication session expired. Please sign in again.');
        }
        await withTimeout(
          firebaseUser.getIdToken(true),
          TOKEN_REFRESH_TIMEOUT_MS,
          'Invite accepted, but token refresh timed out. Please sign in again.'
        );
        if (!mountedRef.current) {
          return;
        }

        const destination = getPostClaimDestination(result.data.effectiveRole);
        setStatus('redirecting');
        const didNavigate = await withTimeout(
          router.replace(destination),
          REDIRECT_TIMEOUT_MS,
          'Invite accepted, but redirect timed out.'
        );
        if (!didNavigate) {
          if (typeof window !== 'undefined') {
            clearInviteClaimAuthMeta();
            window.location.assign(destination);
            return;
          }
          throw new Error('Invite accepted, but redirect was interrupted.');
        }
        clearInviteClaimAuthMeta();
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to claim invite.';
        const isEmailMismatch = message.includes('Invite email does not match authenticated user');
        if (isEmailMismatch) {
          const currentUser = auth.currentUser;
          const authMeta = readInviteClaimAuthMeta();
          const shouldDeleteNewlyCreatedAccount =
            currentUser != null &&
            authMeta?.isNewUser === true &&
            authMeta.uid != null &&
            authMeta.uid === currentUser.uid;

          try {
            if (shouldDeleteNewlyCreatedAccount) {
              await currentUser.delete();
            }
            await auth.signOut();
          } catch (_signOutError) {
            // Keep showing the invite mismatch error even if sign out fails.
          }
          const loginNoticeMessage = shouldDeleteNewlyCreatedAccount
            ? `${message} The newly created account was removed. Sign in with the invited email.`
            : `${message} You were signed out. Sign in with the invited email.`;
          setInviteLoginNotice(loginNoticeMessage);
          clearInviteClaimAuthMeta();
          attemptedTokenRef.current = null;
          authRedirectStartedRef.current = false;
          setStatus('redirecting');
          setErrorMessage('');
          await router.replace(
            `/login?callbackurl=${encodeURIComponent(`/invite/claim?token=${encodeURIComponent(token)}`)}`
          );
          return;
        }

        clearInviteClaimAuthMeta();
        setStatus('error');
        setErrorMessage(`${message} If this invite is expired or consumed, request a fresh invite from an admin.`);
      }
    };

    claimInvite();
  }, [router, router.isReady, router.query.token, loading, user]);

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 560, p: { xs: 3, sm: 4 } }}>
        {(status === 'idle' || status === 'loading' || status === 'redirecting' || status === 'claiming') && (
          <Stack spacing={2} alignItems="center" textAlign="center">
            <CircularProgress />
            <Typography variant="h6">Claiming your invite</Typography>
            <Typography color="text.secondary">
              {status === 'redirecting'
                ? (signedInEmail ? 'Invite accepted. Redirecting...' : 'Redirecting to login so we can verify your account...')
                : 'Please wait while we process your invite.'}
            </Typography>
            {signedInEmail && status === 'claiming' && (
              <Alert severity="info" sx={{ width: '100%', textAlign: 'left' }}>
                Signed in as <strong>{signedInEmail}</strong>
              </Alert>
            )}
          </Stack>
        )}
        {status === 'error' && (
          <Stack spacing={2}>
            <Typography variant="h6">Invite Claim Failed</Typography>
            <Alert severity="error">{errorMessage}</Alert>
            {signedInEmail && (
              <Alert severity="info">Signed in as {signedInEmail}</Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button
                variant="contained"
                onClick={() => {
                  attemptedTokenRef.current = null;
                  authRedirectStartedRef.current = false;
                  setStatus('idle');
                  setErrorMessage('');
                  router.replace(router.asPath);
                }}
              >
                Retry
              </Button>
              <Button variant="outlined" onClick={() => router.push('/')}>
                Go Home
              </Button>
              <Button
                variant="outlined"
                onClick={async () => {
                  await auth.signOut();
                  attemptedTokenRef.current = null;
                  authRedirectStartedRef.current = false;
                  setStatus('redirecting');
                  setErrorMessage('');
                  router.replace(router.asPath);
                }}
              >
                Use Different Account
              </Button>
            </Stack>
          </Stack>
        )}
      </Paper>
    </Box>
  );
};

export default InviteClaimPage;
