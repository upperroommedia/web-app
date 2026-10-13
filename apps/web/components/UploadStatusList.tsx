import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DurableJob } from '@upperroom/contracts/temporal';

/** Publication outcomes come from durable server confirmation, independent of request transport. */
export default function UploadStatusList({ job }: { job: DurableJob }) {
  const destinations = job.destinations ?? [];
  if (destinations.length === 0) return null;
  const labels = {
    subsplash: 'Subsplash',
    soundcloud: 'SoundCloud',
    storage: 'Audio storage',
    algolia: 'Search',
    email: 'Email',
  };
  const states = {
    pending: 'Waiting',
    running: 'In progress',
    confirmed: 'Confirmed',
    absent: 'Not published',
    unknown: 'Checking destination',
    failed: 'Needs attention',
  };
  return (
    <Stack spacing={1} aria-label="Destination outcomes">
      <Typography variant="subtitle1">Destinations</Typography>
      {destinations.map((destination, index) => (
        <Stack key={`${destination.destination}-${destination.remoteId ?? index}`} spacing={0.5}>
          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
            <Typography variant="body2">{labels[destination.destination]}</Typography>
            <Chip
              size="small"
              variant="outlined"
              label={states[destination.state]}
              color={
                destination.state === 'confirmed'
                  ? 'success'
                  : destination.state === 'unknown' || destination.state === 'failed'
                  ? 'warning'
                  : 'default'
              }
            />
          </Stack>
          {destination.message && (
            <Typography variant="body2" color="text.secondary">
              {destination.message}
            </Typography>
          )}
          {destination.state === 'unknown' && (
            <Alert severity="info">
              The destination may have completed this request. We will check before trying again.
            </Alert>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
