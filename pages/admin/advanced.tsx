import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import LaunchIcon from '@mui/icons-material/Launch';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/router';
import AppLayout from '../../layout/AppLayout';
import useAuth from '../../context/user/UserContext';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  clearPendingSoundCloudOAuth,
  createOAuthState,
  createPkcePair,
  storePendingSoundCloudOAuth,
} from '../../utils/soundcloudOAuth';
import type {
  GetSoundCloudAuthStatusInput,
  GetSoundCloudAuthStatusReturnType,
} from '../../functions/src/getSoundCloudAuthStatus';

type NoticeState = {
  severity: 'success' | 'error' | 'info' | 'warning';
  text: string;
} | null;

const formatTimestamp = (value?: number): string => {
  if (!value) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
};

const AdvancedAdminPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const [status, setStatus] = useState<GetSoundCloudAuthStatusReturnType | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isAdmin = user?.isAdmin() ?? false;
  const redirectUri = useMemo(() => {
    if (typeof window === 'undefined') {
      return '';
    }

    const callbackPath = status?.callbackPath ?? '/auth/soundcloud/callback';
    return `${window.location.origin}${callbackPath}`;
  }, [status?.callbackPath]);

  const loadStatus = useCallback(async () => {
    if (!isAdmin) {
      setIsLoadingStatus(false);
      return;
    }

    setIsLoadingStatus(true);
    try {
      const getStatus = createFunctionV2<GetSoundCloudAuthStatusInput, GetSoundCloudAuthStatusReturnType>(
        'getSoundCloudAuthStatus'
      );
      const nextStatus = await getStatus({});
      setStatus(nextStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load SoundCloud auth status.';
      setNotice({ severity: 'error', text: message });
    } finally {
      setIsLoadingStatus(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!router.isReady) {
      return;
    }

    const soundCloudStatus = typeof router.query.soundcloud === 'string' ? router.query.soundcloud : null;
    if (soundCloudStatus === 'connected') {
      setNotice({ severity: 'success', text: 'SoundCloud was connected successfully.' });
      clearPendingSoundCloudOAuth();
      router.replace('/admin/advanced', undefined, { shallow: true });
      loadStatus();
      return;
    }

    if (soundCloudStatus === 'error') {
      const message =
        typeof router.query.message === 'string'
          ? router.query.message
          : 'SoundCloud authorization did not complete.';
      setNotice({ severity: 'error', text: message });
      router.replace('/admin/advanced', undefined, { shallow: true });
    }
  }, [loadStatus, router, router.isReady, router.query.message, router.query.soundcloud]);

  const startSoundCloudConnect = useCallback(async () => {
    if (!status?.clientId || !redirectUri) {
      setNotice({
        severity: 'error',
        text: 'SoundCloud client configuration is missing. Set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET first.',
      });
      return;
    }

    setIsConnecting(true);
    setNotice(null);

    try {
      const { codeVerifier, codeChallenge } = await createPkcePair();
      const state = createOAuthState();

      storePendingSoundCloudOAuth({
        state,
        codeVerifier,
        redirectUri,
        createdAtMillis: Date.now(),
      });

      const authorizeUrl = new URL('https://secure.soundcloud.com/authorize');
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', status.clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('code_challenge', codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('state', state);

      window.location.assign(authorizeUrl.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start the SoundCloud authorization flow.';
      setNotice({ severity: 'error', text: message });
      setIsConnecting(false);
    }
  }, [redirectUri, status?.clientId]);

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', width: '100%' }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Advanced
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            Manage operational integrations that need one-time administrative authorization.
          </Typography>
        </Box>

        {!isAdmin ? (
          <Alert severity="warning">Only admins can manage advanced integration settings.</Alert>
        ) : null}

        {notice ? <Alert severity={notice.severity}>{notice.text}</Alert> : null}

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2.5}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                spacing={1.5}
              >
                <Box>
                  <Typography variant="h6" fontWeight={700}>
                    SoundCloud
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Uses SoundCloud&apos;s OAuth 2.1 authorization-code flow with PKCE. One admin login grants a refresh
                    token that the server can use to rotate access tokens automatically for future publishes.
                  </Typography>
                </Box>
                {isLoadingStatus ? (
                  <CircularProgress size={24} />
                ) : (
                  <Chip
                    color={status?.connected ? 'success' : 'default'}
                    label={status?.connected ? 'Connected' : 'Not connected'}
                    variant={status?.connected ? 'filled' : 'outlined'}
                  />
                )}
              </Stack>

              <Divider />

              <Stack spacing={1.25}>
                <Typography variant="subtitle2">Callback URL</Typography>
                <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                  {redirectUri || 'Loading...'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  This exact URL must be registered in the SoundCloud app configuration.
                </Typography>
              </Stack>

              <Stack spacing={1.25}>
                <Typography variant="subtitle2">Connection details</Typography>
                <Typography variant="body2" color="text.secondary">
                  Last connected: {formatTimestamp(status?.connectedAtMillis)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Access token expires: {formatTimestamp(status?.accessTokenExpiresAtMillis)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Connected by: {status?.connectedByEmail ?? 'Not recorded'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Token source: {status?.tokenSource ?? 'unknown'}
                </Typography>
              </Stack>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                <Button
                  variant="contained"
                  onClick={startSoundCloudConnect}
                  disabled={!isAdmin || isLoadingStatus || isConnecting || !status?.configured || !status?.clientId}
                >
                  {isConnecting ? 'Redirecting...' : status?.connected ? 'Reconnect SoundCloud' : 'Connect SoundCloud'}
                </Button>
                <Button variant="outlined" onClick={loadStatus} disabled={!isAdmin || isLoadingStatus || isConnecting}>
                  Refresh Status
                </Button>
                <Button
                  variant="text"
                  endIcon={<LaunchIcon />}
                  href="https://developers.soundcloud.com/docs/api/guide#authentication"
                  target="_blank"
                  rel="noreferrer"
                >
                  SoundCloud auth docs
                </Button>
              </Stack>

              {!status?.configured ? (
                <Alert severity="warning">
                  Functions still need <code>SOUNDCLOUD_CLIENT_ID</code> and <code>SOUNDCLOUD_CLIENT_SECRET</code>{' '}
                  configured before this flow can run.
                </Alert>
              ) : null}
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
};

AdvancedAdminPage.getLayout = (page: ReactElement) => <AppLayout>{page}</AppLayout>;

export default AdvancedAdminPage;
