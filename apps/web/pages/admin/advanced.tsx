import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NextPage } from 'next';
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
} from '@upperroom/contracts/getSoundCloudAuthStatus';
import type {
  UpdateAllSpeakerTagsInputType,
  UpdateAllSpeakerTagsOutputType,
} from '@upperroom/contracts/updateAllSpeakerTags';
import type { UpdateAllSpeakerTagsResultType } from '@upperroom/contracts/updateAllSpeakerTags';

type NoticeState = {
  severity: 'success' | 'error' | 'info' | 'warning';
  text: string;
} | null;

const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const formatCallableError = (error: unknown, fallbackMessage: string): string => {
  if (error instanceof Error && error.message && error.message !== 'internal') {
    return error.message;
  }

  if (isObjectRecord(error)) {
    const details = isObjectRecord(error.details) ? error.details : null;
    const detailMessage = typeof details?.message === 'string'
      ? details.message
      : typeof details?.error === 'string'
        ? details.error
        : null;
    if (detailMessage) {
      return detailMessage;
    }

    const upstreamStatus = typeof details?.upstream_status === 'number' ? details.upstream_status : null;
    const upstreamText = details?.upstream ? JSON.stringify(details.upstream) : null;
    if (upstreamStatus && upstreamText) {
      return `Speaker tag sync failed upstream with status ${upstreamStatus}: ${upstreamText}`;
    }
    if (upstreamStatus) {
      return `Speaker tag sync failed upstream with status ${upstreamStatus}.`;
    }

    const code = typeof error.code === 'string' ? error.code : null;
    if (code === 'deadline-exceeded') {
      return 'The speaker tag sync ran longer than the current callable timeout before it could return a summary.';
    }
  }

  if (error instanceof Error && error.message) {
    return error.message === 'internal'
      ? 'The speaker tag sync failed before it could return a useful summary. Check the function logs for the last processed speaker.'
      : error.message;
  }

  return fallbackMessage;
};

const formatTimestamp = (value?: number): string => {
  if (!value) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
};

const AdvancedAdminPage: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  const router = useRouter();
  const { user } = useAuth();
  const [status, setStatus] = useState<GetSoundCloudAuthStatusReturnType | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRunningSpeakerTagUpdate, setIsRunningSpeakerTagUpdate] = useState(false);
  const [speakerTagUpdateResult, setSpeakerTagUpdateResult] = useState<UpdateAllSpeakerTagsResultType | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isAdmin = user?.isAdmin() ?? false;
  const canRunScripts = isAdmin && user?.email?.trim().toLowerCase() === SCRIPT_RUNNER_EMAIL;
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

  const runUpdateAllSpeakerTags = useCallback(async () => {
    if (!canRunScripts) {
      setNotice({ severity: 'error', text: 'You are not allowed to run admin scripts.' });
      return;
    }

    setIsRunningSpeakerTagUpdate(true);
    setSpeakerTagUpdateResult(null);
    setNotice({ severity: 'info', text: 'Updating Subsplash speaker tags from Firebase images…' });
    try {
      const updateAllSpeakerTags = createFunctionV2<UpdateAllSpeakerTagsInputType, UpdateAllSpeakerTagsOutputType>(
        'updateallspeakertags'
      );
      const result = await updateAllSpeakerTags({});
      if (result.status !== 'success') {
        setNotice({ severity: 'error', text: result.error });
        return;
      }

      setSpeakerTagUpdateResult(result.data);

      const rateLimitText = result.data.abortedDueToRateLimit
        ? ` Rate limited after ${result.data.updatedCount} updates.${result.data.retryAfterMs ? ` Retry after about ${Math.ceil(result.data.retryAfterMs / 1000)}s.` : ''}`
        : '';
      const failureText = result.data.failedCount > 0
        ? ` ${result.data.failedCount} speaker tags failed.`
        : '';
      setNotice({
        severity: result.data.abortedDueToRateLimit || result.data.failedCount > 0 ? 'warning' : 'success',
        text: `Updated ${result.data.updatedCount} speaker tags. Skipped ${result.data.skippedNoTagCount} without tags, ${result.data.skippedNoSquareImageCount} without square images, and ${result.data.skippedNoNameCount} without names.${failureText}${rateLimitText}`,
      });
    } catch (error) {
      const message = formatCallableError(error, 'Failed to update speaker tags.');
      setNotice({ severity: 'error', text: message });
    } finally {
      setIsRunningSpeakerTagUpdate(false);
    }
  }, [canRunScripts]);

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

        {canRunScripts ? (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="h6" fontWeight={700}>
                    Scripts
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Temporary one-off maintenance actions. These are restricted to a single designated admin account.
                  </Typography>
                </Box>

                <Divider />

                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', sm: 'center' }}
                  spacing={1.5}
                >
                  <Box>
                    <Typography variant="subtitle1" fontWeight={700}>
                      Update All Speaker Tags
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      Sync every Subsplash speaker tag square icon with the current Firebase speaker square image.
                    </Typography>
                  </Box>
                  <Button
                    variant="contained"
                    onClick={runUpdateAllSpeakerTags}
                    disabled={isRunningSpeakerTagUpdate}
                  >
                    {isRunningSpeakerTagUpdate ? 'Updating…' : 'Update All Speaker Tags'}
                  </Button>
                </Stack>

                {speakerTagUpdateResult ? (
                  <Card variant="outlined" sx={{ bgcolor: 'background.default' }}>
                    <CardContent>
                      <Stack spacing={2}>
                        <Box>
                          <Typography variant="subtitle1" fontWeight={700}>
                            Last Run Summary
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            Clear result summary for the most recent speaker-tag sync run.
                          </Typography>
                        </Box>

                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                          <Chip color="success" label={`${speakerTagUpdateResult.updatedCount} updated`} />
                          <Chip label={`${speakerTagUpdateResult.totalSpeakers} total speakers`} />
                          <Chip label={`${speakerTagUpdateResult.skippedNoTagCount} skipped: no tag`} />
                          <Chip label={`${speakerTagUpdateResult.skippedNoSquareImageCount} skipped: no square image`} />
                          <Chip label={`${speakerTagUpdateResult.skippedNoNameCount} skipped: no name`} />
                          <Chip
                            color={speakerTagUpdateResult.failedCount > 0 ? 'error' : 'default'}
                            label={`${speakerTagUpdateResult.failedCount} failed`}
                          />
                          {speakerTagUpdateResult.abortedDueToRateLimit ? (
                            <Chip
                              color="warning"
                              label={
                                speakerTagUpdateResult.retryAfterMs
                                  ? `rate limited, retry after ~${Math.ceil(speakerTagUpdateResult.retryAfterMs / 1000)}s`
                                  : 'rate limited'
                              }
                            />
                          ) : null}
                        </Stack>

                        {speakerTagUpdateResult.failedSpeakers.length > 0 ? (
                          <Alert severity="warning">
                            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                              Failed speaker tag updates
                            </Typography>
                            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                              {speakerTagUpdateResult.failedSpeakers.map((failedSpeaker) => (
                                <Box component="li" key={failedSpeaker.speakerId} sx={{ mb: 0.5 }}>
                                  <Typography variant="body2">
                                    {failedSpeaker.name} ({failedSpeaker.speakerId}): {failedSpeaker.error}
                                  </Typography>
                                </Box>
                              ))}
                            </Box>
                          </Alert>
                        ) : (
                          <Alert severity="success">No speaker tag updates failed in the last run.</Alert>
                        )}
                      </Stack>
                    </CardContent>
                  </Card>
                ) : null}
              </Stack>
            </CardContent>
          </Card>
        ) : null}
      </Stack>
    </Box>
  );
};

AdvancedAdminPage.PageLayout = AppLayout;

export default AdvancedAdminPage;
