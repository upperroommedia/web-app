import { useState } from 'react';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AppLayout from '../../../layout/AppLayout';
import useAuth from '../../../context/user/UserContext';
import { useProviderEnvironment } from '../../../context/provider/ProviderEnvironmentContext';
import { createFunctionV2 } from '../../../utils/createFunction';

const CALLBACK = 'https://staging.uploader.upperroommedia.org/auth/soundcloud/callback';
const SandboxConsent: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  const router = useRouter();
  const { user } = useAuth();
  const environment = useProviderEnvironment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready =
    user?.isAdmin() &&
    environment.status?.mode === 'sandbox' &&
    environment.status.ready &&
    !environment.loading &&
    !environment.error;
  async function approve() {
    if (!ready || busy || !router.isReady) return;
    setBusy(true);
    setError(undefined);
    try {
      const { state, redirect_uri, code_challenge, response_type, code_challenge_method } = router.query;
      if (
        typeof state !== 'string' ||
        typeof code_challenge !== 'string' ||
        redirect_uri !== CALLBACK ||
        response_type !== 'code' ||
        code_challenge_method !== 'S256'
      )
        throw new Error('This simulation connection request is invalid. Start again from Advanced settings.');
      const consent = createFunctionV2<
        { state: string; redirectUri: string; codeChallenge: string },
        { code: string; state: string; redirectUri: string }
      >('consentSoundCloudSandboxAuthorization');
      const result = await consent({ state, redirectUri: redirect_uri, codeChallenge: code_challenge });
      if (result.redirectUri !== CALLBACK || result.state !== state || typeof result.code !== 'string' || !result.code)
        throw new Error('The simulation connection response is invalid.');
      const target = new URL(CALLBACK);
      if (target.origin !== window.location.origin)
        throw new Error('Simulation authorization is available only on the staging site.');
      target.searchParams.set('code', result.code);
      target.searchParams.set('state', result.state);
      window.location.assign(target.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to authorize the simulated account.');
      // A submitted consent can have succeeded even when its response was lost. Restart through a new session.
    }
  }
  return (
    <Stack spacing={2} sx={{ maxWidth: 640, mx: 'auto' }}>
      <Typography variant="h5">Connect simulated SoundCloud account</Typography>
      <Typography>
        This staging account is simulated. Approving tests the normal authorization and publishing flow without signing
        in to SoundCloud or changing a real account.
      </Typography>
      {!ready && <Alert severity="warning">An administrator and a verified staging simulation are required.</Alert>}
      {error && <Alert severity="error">{error} Return to Advanced settings to start a new connection.</Alert>}
      <Button variant="contained" disabled={!ready || busy || !router.isReady} onClick={() => void approve()}>
        {busy ? 'Authorizing…' : 'Authorize simulated account'}
      </Button>
      <Button href="/admin/advanced">Back to Advanced settings</Button>
    </Stack>
  );
};
SandboxConsent.PageLayout = AppLayout;
export default SandboxConsent;
