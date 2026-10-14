import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useProviderEnvironment } from '../context/provider/ProviderEnvironmentContext';
export default function ProviderSimulationBanner() {
  const { status, loading, error, refresh } = useProviderEnvironment();
  if (loading)
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        Checking publishing mode…
      </Alert>
    );
  if (error || !status || status.mode === 'blocked')
    return (
      <Alert
        severity="warning"
        sx={{ mb: 2 }}
        action={
          <Button color="inherit" onClick={refresh}>
            Check again
          </Button>
        }
      >
        Publishing mode could not be verified. Publishing is paused.
        {status?.mode === 'blocked' && status.reason === 'catalog-not-ready'
          ? ' The staging test catalog is not ready.'
          : ''}
      </Alert>
    );
  if (status.mode === 'live') return null;
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      Staging simulation: Subsplash and SoundCloud changes are simulated. Uploads and audio processing still use staging
      services.
    </Alert>
  );
}
