import type { DurableEntityRef, DurableJobRef } from '@upperroom/contracts/temporal';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEntityJobs } from '../../hooks/useDurableJobs';
import JobStatusPanel from './JobStatusPanel';

export default function EntityJobHistory({
  entity,
  activeRefs,
}: {
  entity: DurableEntityRef;
  activeRefs?: Record<string, DurableJobRef | undefined>;
}) {
  const { jobs, loading, error, stale } = useEntityJobs(entity, activeRefs);
  return (
    <Stack spacing={1.5} component="section" aria-label="Recent activity">
      <Typography variant="h6">Activity</Typography>
      {error && <Alert severity="warning">{error}</Alert>}
      {loading && <Typography role="status">Loading activity…</Typography>}
      {!loading && jobs.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No recent tasks.
        </Typography>
      )}
      {jobs.map((job) => (
        <JobStatusPanel key={job.jobId} job={job} compact stale={stale} />
      ))}
    </Stack>
  );
}
