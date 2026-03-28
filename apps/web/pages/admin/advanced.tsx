import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
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
import type {
  CreateSoundCloudAuthSessionInput,
  CreateSoundCloudAuthSessionReturnType,
} from '@upperroom/contracts/createSoundCloudAuthSession';
import type {
  GetSoundCloudAuthStatusInput,
  GetSoundCloudAuthStatusReturnType,
} from '@upperroom/contracts/getSoundCloudAuthStatus';
import type {
  UpdateAllSpeakerTagsInputType,
  UpdateAllSpeakerTagsOutputType,
} from '@upperroom/contracts/updateAllSpeakerTags';
import type { UpdateAllSpeakerTagsResultType } from '@upperroom/contracts/updateAllSpeakerTags';
import type {
  GetYouTubeCookieStatusInput,
  GetYouTubeCookieStatusOutputType,
} from '@upperroom/contracts/getYouTubeCookieStatus';
import type {
  SetYouTubeCookiesInput,
  SetYouTubeCookiesOutputType,
} from '@upperroom/contracts/setYouTubeCookies';
import { uploadYouTubeCookiesFromFile } from '../../utils/youtubeCookies';
import {
  getFirebaseDatabaseUrl,
  getFirebaseProjectId,
  getFirebaseStorageBucket,
} from '../../shared/firebaseProjectConfig';

type NoticeState = {
  severity: 'success' | 'error' | 'info' | 'warning';
  text: string;
} | null;

const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';
const YOUTUBE_COOKIE_EXPORT_URL = 'https://www.youtube.com/robots.txt';
const YTDLP_COOKIE_DOCS_URL = 'https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies';

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

const formatIsoTimestamp = (value?: string | null): string => {
  if (!value) {
    return 'Not available';
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed));
};

const buildBrowserFallbackBootstrapCommand = (): string => {
  const projectId = getFirebaseProjectId();
  const storageBucket = getFirebaseStorageBucket();
  const databaseUrl = getFirebaseDatabaseUrl();

  return [
    `FIREBASE_PROJECT_ID=${projectId}`,
    `FIREBASE_STORAGE_BUCKET=${storageBucket}`,
    `FIREBASE_DATABASE_URL=${databaseUrl}`,
    `BROWSER_FALLBACK_PROFILE_BUCKET=${storageBucket}`,
    './scripts/with-node22.sh pnpm --dir apps/browser-fallback exec node scripts/bootstrap-browser-profile.js',
  ].join(' \\\n');
};

const AdvancedAdminPage: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  const router = useRouter();
  const { user } = useAuth();
  const [status, setStatus] = useState<GetSoundCloudAuthStatusReturnType | null>(null);
  const [youtubeCookieStatus, setYouTubeCookieStatus] = useState<GetYouTubeCookieStatusOutputType | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isLoadingCookieStatus, setIsLoadingCookieStatus] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isUploadingYouTubeCookies, setIsUploadingYouTubeCookies] = useState(false);
  const [isRunningSpeakerTagUpdate, setIsRunningSpeakerTagUpdate] = useState(false);
  const [speakerTagUpdateResult, setSpeakerTagUpdateResult] = useState<UpdateAllSpeakerTagsResultType | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isAdmin = user?.isAdmin() ?? false;
  const canRunScripts = isAdmin && user?.email?.trim().toLowerCase() === SCRIPT_RUNNER_EMAIL;
  const browserFallbackBootstrapCommand = useMemo(() => buildBrowserFallbackBootstrapCommand(), []);
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

  const loadYouTubeCookieStatus = useCallback(async () => {
    if (!isAdmin) {
      setIsLoadingCookieStatus(false);
      setYouTubeCookieStatus(null);
      return;
    }

    setIsLoadingCookieStatus(true);
    try {
      const getStatus = createFunctionV2<GetYouTubeCookieStatusInput, GetYouTubeCookieStatusOutputType>(
        'getyoutubecookiestatus'
      );
      const nextStatus = await getStatus({});
      setYouTubeCookieStatus(nextStatus);
    } catch (error) {
      const message = formatCallableError(error, 'Failed to load YouTube cookie status.');
      setNotice({ severity: 'error', text: message });
    } finally {
      setIsLoadingCookieStatus(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadStatus();
    loadYouTubeCookieStatus();
  }, [loadStatus, loadYouTubeCookieStatus]);

  const copyToClipboard = useCallback(async (value: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ severity: 'success', text: successText });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to copy text to the clipboard.';
      setNotice({ severity: 'error', text: message });
    }
  }, []);

  useEffect(() => {
    if (!router.isReady) {
      return;
    }

    const soundCloudStatus = typeof router.query.soundcloud === 'string' ? router.query.soundcloud : null;
    if (soundCloudStatus === 'connected') {
      setNotice({ severity: 'success', text: 'SoundCloud was connected successfully.' });
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
      const createAuthSession = createFunctionV2<
        CreateSoundCloudAuthSessionInput,
        CreateSoundCloudAuthSessionReturnType
      >('createSoundCloudAuthSession');

      const { authorizeUrl } = await createAuthSession({ redirectUri });
      window.location.assign(authorizeUrl);
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

  const handleYouTubeCookieFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      const getYouTubeCookieStatus = createFunctionV2<GetYouTubeCookieStatusInput, GetYouTubeCookieStatusOutputType>(
        'getyoutubecookiestatus'
      );
      const setYouTubeCookies = createFunctionV2<SetYouTubeCookiesInput, SetYouTubeCookiesOutputType>(
        'setyoutubecookies'
      );

      setIsUploadingYouTubeCookies(true);
      setNotice({
        severity: 'info',
        text: `Uploading ${file.name} and preparing a single deferred YouTube probe before the queue resumes…`,
      });

      try {
        const nextStatus = await uploadYouTubeCookiesFromFile({
          file,
          setYouTubeCookies,
          getYouTubeCookieStatus,
        });

        setYouTubeCookieStatus(nextStatus);
        setNotice({
          severity: 'success',
          text: 'YouTube cookies were uploaded. Public videos stay on PO tokens, and the YouTube queue will only resume after a cookie-backed probe succeeds.',
        });
      } catch (error) {
        try {
          const refreshedStatus = await getYouTubeCookieStatus({});
          setYouTubeCookieStatus(refreshedStatus);
        } catch (statusError) {
          console.error('Failed to refresh YouTube cookie status after upload error', statusError);
        }
        const message = formatCallableError(error, 'Failed to upload YouTube cookies.');
        setNotice({ severity: 'error', text: message });
      } finally {
        input.value = '';
        setIsUploadingYouTubeCookies(false);
      }
    },
    []
  );

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

        {isAdmin ? (
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
                      YouTube Cookies
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      Upload a fresh <code>cookies.txt</code> export for the dedicated YouTube account. The client
                      base64-encodes the file immediately, the admin callable stores it in RTDB, and a single deferred
                      auth-required YouTube job is used as the resume probe. Public YouTube extraction stays on PO
                      tokens and does not depend on these cookies.
                    </Typography>
                  </Box>
                  {isLoadingCookieStatus ? (
                    <CircularProgress size={24} />
                  ) : (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                      <Chip
                        color={youtubeCookieStatus?.hasCookies ? 'success' : 'default'}
                        label={youtubeCookieStatus?.hasCookies ? 'Cookies configured' : 'Cookies missing'}
                        variant={youtubeCookieStatus?.hasCookies ? 'filled' : 'outlined'}
                      />
                      <Chip
                        color={youtubeCookieStatus?.cookieBreakerOpen ? 'warning' : 'success'}
                        label={youtubeCookieStatus?.cookieBreakerOpen ? 'Cookie breaker open' : 'Cookie breaker clear'}
                        variant="outlined"
                      />
                      <Chip
                        color={youtubeCookieStatus?.youtubeQueueBlocked ? 'warning' : 'success'}
                        label={youtubeCookieStatus?.youtubeQueueBlocked ? 'YouTube queue paused' : 'YouTube queue active'}
                        variant="outlined"
                      />
                      <Chip
                        color={youtubeCookieStatus?.browserFallbackReachable ? 'success' : 'default'}
                        label={
                          youtubeCookieStatus?.browserFallbackReachable
                            ? 'Browser fallback reachable'
                            : 'Browser fallback unavailable'
                        }
                        variant="outlined"
                      />
                      <Chip
                        color={youtubeCookieStatus?.browserFallbackHealthy ? 'success' : 'warning'}
                        label={
                          youtubeCookieStatus?.browserFallbackHealthy
                            ? 'Browser fallback healthy'
                            : 'Browser fallback unhealthy'
                        }
                        variant="outlined"
                      />
                    </Stack>
                  )}
                </Stack>

                <Divider />

                <Stack spacing={1.5}>
                  <Typography variant="subtitle2">Guided refresh flow</Typography>
                  <Typography variant="body2" color="text.secondary">
                    1. Open a fresh private/incognito browser window manually.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    2. Log into the dedicated YouTube account in that private window only.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    3. In the same private tab, go directly to <code>youtube.com/robots.txt</code>.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    4. Export only the <code>youtube.com</code> cookies as Netscape <code>cookies.txt</code>.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    5. Close the private window immediately after export so YouTube does not rotate the session.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    6. Upload that exported <code>cookies.txt</code> here, then refresh status.
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                    <Button
                      variant="outlined"
                      onClick={() => copyToClipboard(YOUTUBE_COOKIE_EXPORT_URL, 'Copied youtube.com/robots.txt URL.')}
                    >
                      Copy robots.txt URL
                    </Button>
                    <Button
                      variant="outlined"
                      href={YTDLP_COOKIE_DOCS_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open yt-dlp cookie docs
                    </Button>
                  </Stack>
                </Stack>

                <Divider />

                <Stack spacing={1.5}>
                  <Typography variant="subtitle2">Browser fallback recovery</Typography>
                  <Typography variant="body2" color="text.secondary">
                    If browser fallback shows <code>auth_required</code> or <code>missing_profile</code>, rerun the
                    local bootstrap below. If the session still shows <code>authenticated</code> but health stays
                    unhealthy or the last error is <code>session_unhealthy</code>, bootstrap alone is not the fix: the
                    staging runtime or egress path is still failing extraction.
                  </Typography>
                  <Box
                    component="pre"
                    sx={{
                      m: 0,
                      p: 1.5,
                      borderRadius: 1,
                      bgcolor: 'background.default',
                      overflowX: 'auto',
                      fontSize: '0.8rem',
                      lineHeight: 1.5,
                    }}
                  >
                    {browserFallbackBootstrapCommand}
                  </Box>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                    <Button
                      variant="outlined"
                      onClick={() =>
                        copyToClipboard(
                          browserFallbackBootstrapCommand,
                          'Copied browser fallback bootstrap command.'
                        )
                      }
                    >
                      Copy bootstrap command
                    </Button>
                  </Stack>
                </Stack>

                <Divider />

                <Stack spacing={1.25}>
                  <Typography variant="subtitle2">Cookie status</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Disabled until: {formatIsoTimestamp(youtubeCookieStatus?.disabledUntil)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Queue probe status: {youtubeCookieStatus?.probeStatus ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Deferred YouTube requests: {youtubeCookieStatus?.deferredYouTubeTaskCount ?? 0}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Queue blocker reason: {youtubeCookieStatus?.blockerReason ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Queue blocker episode: {youtubeCookieStatus?.blockerEpisodeId ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Queue blocker updated: {formatIsoTimestamp(youtubeCookieStatus?.blockerUpdatedAt)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback configured: {youtubeCookieStatus?.browserFallbackConfigured ? 'Yes' : 'No'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback reachable: {youtubeCookieStatus?.browserFallbackReachable ? 'Yes' : 'No'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback healthy: {youtubeCookieStatus?.browserFallbackHealthy ? 'Yes' : 'No'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback session: {youtubeCookieStatus?.browserFallbackSessionState ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback healthcheck configured:{' '}
                    {youtubeCookieStatus?.browserFallbackHealthcheckConfigured ? 'Yes' : 'No'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback profile updated: {formatIsoTimestamp(youtubeCookieStatus?.browserFallbackProfileUpdatedAt)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback last checked: {formatIsoTimestamp(youtubeCookieStatus?.browserFallbackLastCheckedAt)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback last error code: {youtubeCookieStatus?.browserFallbackLastErrorCode ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback last error: {youtubeCookieStatus?.browserFallbackLastErrorMessage ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Browser fallback blocker active: {youtubeCookieStatus?.browserFallbackBlocked ? 'Yes' : 'No'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Uploaded at: {formatIsoTimestamp(youtubeCookieStatus?.metadata?.uploadedAt)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Uploaded by: {youtubeCookieStatus?.metadata?.uploadedByEmail ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Source file: {youtubeCookieStatus?.metadata?.sourceFileName ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Cookie hash: {youtubeCookieStatus?.metadata?.cookieHash ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Last health status: {youtubeCookieStatus?.metadata?.lastHealthStatus ?? 'Not available'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Last validated: {formatIsoTimestamp(youtubeCookieStatus?.metadata?.lastValidatedAt)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Last used: {formatIsoTimestamp(youtubeCookieStatus?.metadata?.lastUsedAt)}
                  </Typography>
                </Stack>

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Button variant="contained" component="label" disabled={isUploadingYouTubeCookies || isLoadingCookieStatus}>
                    {isUploadingYouTubeCookies ? 'Uploading…' : 'Upload cookies.txt'}
                    <input hidden type="file" accept=".txt,text/plain" onChange={handleYouTubeCookieFileChange} />
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={loadYouTubeCookieStatus}
                    disabled={isUploadingYouTubeCookies || isLoadingCookieStatus}
                  >
                    Refresh Status
                  </Button>
                </Stack>

                <Alert severity="info">
                  This page never reads raw cookie contents back to the browser. It only shows metadata from
                  <code> yt-dlp-cookies-meta</code> plus queue state stored under <code>processAudioQueues/youtube</code>.
                </Alert>

                <Alert severity="warning">
                  yt-dlp recommends exporting YouTube cookies from a fresh private/incognito session that is only used
                  for YouTube, navigating to <code>youtube.com/robots.txt</code>, exporting the Netscape
                  <code>cookies.txt</code>, and then closing that private window immediately. A file that looks valid
                  can still fail validation if YouTube has already rotated or challenged that session.
                </Alert>

                <Alert severity="warning">
                  This page can guide the operator, but it does not and should not read browser cookies directly. The
                  actual YouTube login and cookie export must happen in a separate private/incognito browser session so
                  the exported file stays compatible with yt-dlp and avoids immediate rotation.
                </Alert>
              </Stack>
            </CardContent>
          </Card>
        ) : null}

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
