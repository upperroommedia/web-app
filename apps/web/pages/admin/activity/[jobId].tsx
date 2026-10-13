import { useRouter } from 'next/router';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AppLayout from '../../../layout/AppLayout';
import { useDurableJob } from '../../../hooks/useDurableJobs';
import JobStatusPanel from '../../../components/jobs/JobStatusPanel';

export default function ActivityDetailsPage() {
  const router = useRouter();
  const jobId = typeof router.query.jobId === 'string' ? router.query.jobId : undefined;
  const { job, loading, stale, error } = useDurableJob(jobId);
  return (
    <Stack spacing={2}>
      <Typography variant="h4" component="h1">
        Task details
      </Typography>
      {error && <Alert severity="warning">{error}</Alert>}
      {loading && <Typography role="status">Loading task…</Typography>}
      {!loading && !job && !error && <Typography>This task is unavailable or you do not have access.</Typography>}
      {job && <JobStatusPanel job={job} stale={stale} />}
    </Stack>
  );
}
ActivityDetailsPage.PageLayout = AppLayout;
