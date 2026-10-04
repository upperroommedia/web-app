import Head from 'next/head';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AppLayout from '../../layout/AppLayout';
import useAuth from '../../context/user/UserContext';
import { getYouTubeAdminToken } from '../../utils/youtubeAdminToken';

type Config = { sessionUrl: string; codeConfigured: boolean; credentialsConfigured: boolean };
type Credentials = { email: string; password: string };
type Code = { code: string; expiresAtMs: number; serverTimeMs: number };
type AuthStatus = {
  ready: boolean;
  session: { healthy: boolean | null };
  queue: { depth: number };
  mediaByteCanary: { checkedAt: string | null };
};

const YouTubeAuthPage = () => {
  const { user } = useAuth();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const [connected, setConnected] = useState(false);
  const [code, setCode] = useState<Code | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [credentialsRequested, setCredentialsRequested] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedCredential, setCopiedCredential] = useState<'email' | 'password' | null>(null);
  const isAdmin = user?.isAdmin() ?? false;

  const api = useCallback(
    async (action?: string) => {
      if (!user) throw new Error('Sign in to continue.');
      const response = await fetch('/api/admin/youtube-auth', {
        method: action ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${await getYouTubeAdminToken(user.uid)}`,
          'Content-Type': 'application/json',
        },
        ...(action ? { body: JSON.stringify({ action }) } : {}),
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request failed. Please try again.');
      return result;
    },
    [user]
  );

  const requestRecovery = async () => {
    setCheckingRecovery(true);
    setError(null);
    try {
      await api('recover');
      await checkStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recovery.');
    } finally {
      setCheckingRecovery(false);
    }
  };

  const checkStatus = useCallback(async () => {
    try {
      setStatus((await api('status')).authenticated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check YouTube.');
    }
  }, [api]);

  useEffect(() => {
    if (!isAdmin) {
      setConfig(null);
      setCode(null);
      setConnected(false);
      return;
    }
    let active = true;
    void api()
      .then((result) => {
        if (active) setConfig(result);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    void checkStatus();
    const timer = setInterval(() => {
      void checkStatus();
    }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, checkStatus, isAdmin]);

  useEffect(() => {
    setCredentials(null);
    setShowPassword(false);
    setCopiedCredential(null);
    if (!isAdmin || !credentialsRequested) return;
    let active = true;
    void api('credentials')
      .then((result: Credentials) => {
        if (active) setCredentials(result);
      })
      .catch((err) => {
        if (active) {
          setError(err.message);
          setCredentialsRequested(false);
        }
      });
    const timer = setTimeout(() => setCredentialsRequested(false), 5 * 60_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, isAdmin, credentialsRequested]);

  const copyCredential = async (field: 'email' | 'password') => {
    if (!isAdmin || !credentials) return;
    try {
      await navigator.clipboard.writeText(credentials[field]);
      setCopiedCredential(field);
    } catch {
      setError('Could not copy the login detail. Select and copy it manually.');
    }
  };

  useEffect(() => {
    if (!code) return;
    const receivedAt = Date.now();
    const duration = code.expiresAtMs - code.serverTimeMs;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((duration - (Date.now() - receivedAt)) / 1000));
      setRemaining(seconds);
      if (!seconds) setCode(null);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [code]);

  const connect = async (newTab = false) => {
    if (!config || !user) return;
    // Open during the click to preserve popup permission; submit the token in a POST body.
    const target = newTab ? window.open('about:blank', '_blank') : null;
    if (newTab && !target) {
      setError('Allow popups for this site to open the remote browser.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getYouTubeAdminToken(user.uid, true);
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = config.sessionUrl;
      const targetName = newTab ? `youtube-desktop-${Date.now()}` : 'youtube-desktop';
      if (target) target.name = targetName;
      form.target = targetName;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'idToken';
      field.value = token;
      form.appendChild(field);
      document.body.appendChild(form);
      form.submit();
      form.remove();
      if (target) target.opener = null;
      if (!newTab) setConnected(true);
    } catch (err) {
      target?.close();
      setError(err instanceof Error ? err.message : 'Could not open the remote browser.');
    } finally {
      setBusy(false);
    }
  };

  const generateCode = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    setCode(null);
    const startedAt = performance.now();
    try {
      const result: Code = await api('code');
      setCode({ ...result, serverTimeMs: result.serverTimeMs + (performance.now() - startedAt) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a code.');
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return <Alert severity="warning">Sign in with an admin account to restore YouTube access.</Alert>;

  return (
    <>
      <Head>
        <title>Restore YouTube Access | Upper Room Media</title>
        <meta name="robots" content="noindex" />
      </Head>
      <Stack spacing={3} sx={{ width: '100%', maxWidth: 1400, mx: 'auto' }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Restore YouTube access
          </Typography>
          <Typography color="text.secondary">
            Sign in to the shared Google account in the processing server&apos;s browser.
          </Typography>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        <Alert severity={status?.ready ? 'success' : 'info'}>
          {status?.ready
            ? 'YouTube authentication is verified. Waiting audio jobs can resume automatically.'
            : 'After signing in, keep this page open while the server verifies that it can download audio. Waiting jobs trigger a download check every minute, even after you close this page. Click Check recovery status to request a check now.'}
          {status ? ` Waiting jobs: ${status.queue.depth}.` : ''}
          {status?.mediaByteCanary.checkedAt
            ? ` Last audio check: ${new Date(status.mediaByteCanary.checkedAt).toLocaleString()}.`
            : ''}
        </Alert>
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Login instructions</Typography>
              <Box component="ol" sx={{ m: 0, pl: 3 }}>
                <li>
                  Click Open remote browser. This is the shared desktop on Hetzner; coordinate with other admins before
                  using it.
                </li>
                <li>
                  In the remote Chrome window, go to youtube.com and click Sign in. Use the shared Upper Room Media
                  Google account. Click Show login details below, then copy the email and password into the remote
                  browser.
                </li>
                <li>
                  If Google asks for verification, choose Try another way, then the Authenticator code option. Click
                  Generate Google code below and type the six digits in the remote browser before the countdown ends.
                </li>
                <li>
                  Confirm the account avatar appears on YouTube and a video plays. Leave Chrome open and signed in.
                </li>
                <li>
                  Click Check recovery status to check audio access now. The server also checks automatically every
                  minute while sermons are waiting and resumes jobs once the authenticated download check succeeds.
                </li>
              </Box>
              <Stack spacing={1.5} className="sentry-block">
                <Typography variant="subtitle1">Shared Google account</Typography>
                {config && !config.credentialsConfigured && (
                  <Alert severity="warning">
                    Google login details have not been configured. Contact the system administrator.
                  </Alert>
                )}
                <Box>
                  <Button
                    variant="outlined"
                    disabled={!config?.credentialsConfigured}
                    onClick={() => setCredentialsRequested((value) => !value)}
                  >
                    {credentialsRequested ? 'Hide login details' : 'Show login details'}
                  </Button>
                </Box>
                {credentialsRequested && !credentials && <Typography>Loading login details…</Typography>}
                {credentialsRequested && credentials && (
                  <>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
                      <TextField
                        label="Google email"
                        value={credentials.email}
                        fullWidth
                        slotProps={{ input: { readOnly: true } }}
                      />
                      <Button
                        onClick={() => {
                          void copyCredential('email');
                        }}
                      >
                        {copiedCredential === 'email' ? 'Copied' : 'Copy email'}
                      </Button>
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
                      <TextField
                        label="Google password"
                        value={credentials.password}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="off"
                        fullWidth
                        slotProps={{ input: { readOnly: true } }}
                      />
                      <Button onClick={() => setShowPassword((value) => !value)}>
                        {showPassword ? 'Hide password' : 'Show password'}
                      </Button>
                      <Button
                        onClick={() => {
                          void copyCredential('password');
                        }}
                      >
                        {copiedCredential === 'password' ? 'Copied' : 'Copy password'}
                      </Button>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      Login details are available only to admins and hide automatically after five minutes.
                    </Typography>
                  </>
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Desktop access expires after 15 minutes. Reopen it to continue. If the embedded browser stays blank or
                asks you to reconnect, use Open in a new tab. Closing this page leaves the server&apos;s Google session
                signed in.
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  variant="contained"
                  disabled={!config || busy}
                  onClick={() => {
                    void connect();
                  }}
                >
                  {connected ? 'Reconnect remote browser' : 'Open remote browser'}
                </Button>
                <Button
                  disabled={!config || busy}
                  onClick={() => {
                    void connect(true);
                  }}
                >
                  Open in a new tab
                </Button>
                <Button
                  disabled={checkingRecovery}
                  onClick={() => {
                    void requestRecovery();
                  }}
                >
                  {checkingRecovery ? 'Requesting recovery check…' : 'Check recovery status'}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Typography variant="h6">Google verification code</Typography>
              <Typography variant="body2">
                Generate a code only when Google asks for an Authenticator code. This is for the shared Google account.
              </Typography>
              {config && !config.codeConfigured && (
                <Alert severity="warning">
                  Google code generation has not been configured. Contact the system administrator.
                </Alert>
              )}
              <Box>
                <Button
                  variant="outlined"
                  disabled={busy || !config?.codeConfigured}
                  onClick={() => {
                    void generateCode();
                  }}
                >
                  Generate Google code
                </Button>
              </Box>
              {code && remaining > 0 && (
                <Stack direction="row" spacing={2} alignItems="center" className="sentry-block">
                  <Typography variant="h4" component="span" sx={{ fontFamily: 'monospace', letterSpacing: 4 }}>
                    {code.code}
                  </Typography>
                  <Typography>Expires in {remaining}s</Typography>
                  <Button
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(code.code)
                        .then(() => setCopied(true))
                        .catch(() => setError('Could not copy the code. Type it into the remote browser.'));
                    }}
                  >
                    {copied ? 'Copied' : 'Copy code'}
                  </Button>
                </Stack>
              )}
            </Stack>
          </CardContent>
        </Card>
        <Box
          component="iframe"
          name="youtube-desktop"
          title="Hetzner YouTube login browser"
          src="about:blank"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          sx={{
            display: connected ? 'block' : 'none',
            width: '100%',
            height: 'min(75vh, 900px)',
            minHeight: 480,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        />
      </Stack>
    </>
  );
};
YouTubeAuthPage.PageLayout = AppLayout;
export default YouTubeAuthPage;
