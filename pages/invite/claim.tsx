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
import { ClaimInviteInputType, ClaimInviteResultData } from '../../functions/src/invites/inviteTypes';
import { createFunctionV2 } from '../../utils/createFunction';

type ClaimInviteOutputType = { status: 'success'; data: ClaimInviteResultData } | { status: 'error'; error: string };
type ClaimStatus = 'idle' | 'loading' | 'redirecting' | 'claiming' | 'error';

const readToken = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return (value[0] ?? '').trim();
  }
  return (value ?? '').trim();
};

const InviteClaimPage = () => {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<ClaimStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const attemptedTokenRef = useRef<string | null>(null);
  const authRedirectStartedRef = useRef(false);

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
      setStatus('loading');
      return;
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
    let active = true;

    const claimInvite = async () => {
      setStatus('claiming');
      setErrorMessage('');

      try {
        const claimInviteCallable = createFunctionV2<ClaimInviteInputType, ClaimInviteOutputType>('claiminvite');
        const result = await claimInviteCallable({ token });

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        await user.getIdToken(true);
        if (!active) {
          return;
        }

        await router.replace('/invite/success');
      } catch (error) {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to claim invite.';
        setStatus('error');
        setErrorMessage(`${message} If this invite is expired or consumed, request a fresh invite from an admin.`);
      }
    };

    claimInvite();

    return () => {
      active = false;
    };
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
                ? 'Redirecting to login so we can verify your account...'
                : 'Please wait while we process your invite.'}
            </Typography>
          </Stack>
        )}
        {status === 'error' && (
          <Stack spacing={2}>
            <Typography variant="h6">Invite Claim Failed</Typography>
            <Alert severity="error">{errorMessage}</Alert>
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
            </Stack>
          </Stack>
        )}
      </Paper>
    </Box>
  );
};

export default InviteClaimPage;
