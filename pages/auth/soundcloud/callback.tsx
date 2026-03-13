import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/router';
import AppLayout from '../../../layout/AppLayout';
import { createFunctionV2 } from '../../../utils/createFunction';
import { clearPendingSoundCloudOAuth, readPendingSoundCloudOAuth } from '../../../utils/soundcloudOAuth';
import type {
  ExchangeSoundCloudAuthCodeInput,
  ExchangeSoundCloudAuthCodeReturnType,
} from '../../../functions/src/exchangeSoundCloudAuthCode';

const SoundCloudCallbackPage = () => {
  const router = useRouter();
  const [statusText, setStatusText] = useState('Finalizing SoundCloud authorization...');
  const [errorText, setErrorText] = useState<string | null>(null);

  const callbackState = useMemo(() => {
    if (!router.isReady || typeof window === 'undefined') {
      return { ready: false } as const;
    }

    const code = typeof router.query.code === 'string' ? router.query.code : null;
    const returnedState = typeof router.query.state === 'string' ? router.query.state : null;
    const providerError = typeof router.query.error === 'string' ? router.query.error : null;
    const providerErrorDescription =
      typeof router.query.error_description === 'string' ? router.query.error_description : null;

    if (providerError) {
      return {
        ready: true,
        validationError: providerErrorDescription ?? providerError,
      } as const;
    }

    if (!code) {
      return {
        ready: true,
        validationError: 'SoundCloud did not return an authorization code.',
      } as const;
    }

    const pendingAuth = readPendingSoundCloudOAuth();
    if (!pendingAuth) {
      return {
        ready: true,
        validationError: 'The SoundCloud login session was not found. Start the flow again from Admin > Advanced.',
      } as const;
    }

    if (!returnedState || returnedState !== pendingAuth.state) {
      return {
        ready: true,
        validationError: 'The SoundCloud OAuth state did not match the original request.',
        shouldClearPendingAuth: true,
      } as const;
    }

    return {
      ready: true,
      code,
      pendingAuth,
    } as const;
  }, [router.isReady, router.query.code, router.query.error, router.query.error_description, router.query.state]);

  useEffect(() => {
    if (callbackState.ready && callbackState.shouldClearPendingAuth) {
      clearPendingSoundCloudOAuth();
    }
  }, [callbackState]);

  useEffect(() => {
    if (!callbackState.ready || 'validationError' in callbackState) {
      return;
    }

    let isCancelled = false;

    const run = async () => {
      try {
        const exchangeAuthCode = createFunctionV2<
          ExchangeSoundCloudAuthCodeInput,
          ExchangeSoundCloudAuthCodeReturnType
        >('exchangeSoundCloudAuthCode');

        setStatusText('Exchanging SoundCloud authorization for runtime tokens...');
        await exchangeAuthCode({
          code: callbackState.code,
          codeVerifier: callbackState.pendingAuth.codeVerifier,
          redirectUri: callbackState.pendingAuth.redirectUri,
        });

        if (isCancelled) {
          return;
        }

        clearPendingSoundCloudOAuth();
        setStatusText('SoundCloud is connected. Returning to Advanced settings...');
        await router.replace('/admin/advanced?soundcloud=connected');
      } catch (error) {
        if (isCancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : 'SoundCloud authorization could not be completed.';
        setErrorText(message);
      }
    };

    run();

    return () => {
      isCancelled = true;
    };
  }, [callbackState, router]);

  const resolvedErrorText = errorText ?? (callbackState.ready && 'validationError' in callbackState ? callbackState.validationError : null);

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', width: '100%', py: { xs: 4, md: 8 } }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2.5} alignItems="flex-start">
            <Typography variant="h5" fontWeight={700}>
              SoundCloud Authorization
            </Typography>
            {resolvedErrorText ? <Alert severity="error">{resolvedErrorText}</Alert> : null}
            {!resolvedErrorText ? (
              <Stack direction="row" spacing={1.5} alignItems="center">
                <CircularProgress size={24} />
                <Typography variant="body1">{statusText}</Typography>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                You can return to Advanced settings and start the connection flow again.
              </Typography>
            )}
            {resolvedErrorText ? (
              <Button
                variant="contained"
                onClick={() => {
                  clearPendingSoundCloudOAuth();
                  router.push('/admin/advanced?soundcloud=error&message=' + encodeURIComponent(resolvedErrorText));
                }}
              >
                Back to Advanced
              </Button>
            ) : null}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
};

SoundCloudCallbackPage.getLayout = (page: ReactElement) => <AppLayout>{page}</AppLayout>;

export default SoundCloudCallbackPage;
