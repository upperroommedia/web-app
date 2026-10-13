import { useState } from 'react';
import Link from 'next/link';
import { isDurableJobTerminal } from '@upperroom/contracts/temporal';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AppLayout from '../../../layout/AppLayout';
import useAuth from '../../../context/user/UserContext';
import { useVisibleJobPage } from '../../../hooks/useDurableJobs';
import JobStatusPanel from '../../../components/jobs/JobStatusPanel';
import { ACTIVITY_PAGE_SIZE, type JobPageCursor } from '../../../utils/jobPaging';
import { recoverPendingDurableRequests } from '../../../utils/durableJobs';

export default function ActivityPage() {
  const { user } = useAuth();
  const identity = `${user?.uid ?? ''}:${Boolean(user?.isAdmin())}`;
  const [paginationIdentity, setPaginationIdentity] = useState(identity);
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all');
  const [cursors, setCursors] = useState<(JobPageCursor | undefined)[]>([undefined]);
  if (paginationIdentity !== identity) {
    setPaginationIdentity(identity);
    setCursors([undefined]);
  }
  const [recovering, setRecovering] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [recoveredIds, setRecoveredIds] = useState<string[]>([]);
  const { jobs, loading, stale, error, hasOlder, olderCursor } = useVisibleJobPage(filter, cursors[cursors.length - 1]);
  const visible = jobs.filter(
    (job) =>
      filter === 'all' ||
      (filter === 'active'
        ? !isDurableJobTerminal(job.state)
        : ['needs_attention', 'failed', 'waiting_for_auth'].includes(job.state))
  );
  return (
    <Stack spacing={2}>
      <Typography variant="h4" component="h1">
        Activity
      </Typography>
      <Typography color="text.secondary">
        Uploads, processing and publishing continue here when you leave a page.
      </Typography>
      <Button
        disabled={recovering}
        variant="text"
        sx={{ alignSelf: 'flex-start' }}
        onClick={async () => {
          setRecovering(true);
          try {
            const result = await recoverPendingDurableRequests();
            setRecoveredIds(result.receipts.map((receipt) => receipt.jobId));
            setRecoveryNotice(
              result.uncertain
                ? `${result.receipts.length} accepted requests recovered. ${result.uncertain} requests still cannot be confirmed; retain their source and retry the same selection when connected.`
                : result.receipts.length
                ? `${result.receipts.length} accepted requests recovered. Their status appears in Activity.`
                : 'No unconfirmed requests were found on this device.'
            );
          } catch (error) {
            setRecoveryNotice(error instanceof Error ? error.message : 'Requests could not be checked.');
          } finally {
            setRecovering(false);
          }
        }}
      >
        {recovering ? 'Checking pending requests…' : 'Check unconfirmed requests from this device'}
      </Button>
      {recoveryNotice && (
        <Alert severity="info" role="status">
          {recoveryNotice}
        </Alert>
      )}
      {recoveredIds.map((jobId) => (
        <Button
          component={Link}
          href={`/admin/activity/${encodeURIComponent(jobId)}`}
          key={jobId}
          sx={{ alignSelf: 'flex-start' }}
        >
          Open recovered task
        </Button>
      ))}
      <Stack direction="row" gap={1} flexWrap="wrap" role="group" aria-label="Filter activity">
        {(['all', 'active', 'attention'] as const).map((value) => (
          <Button
            key={value}
            variant={filter === value ? 'contained' : 'outlined'}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setCursors([undefined]);
            }}
          >
            {value === 'all' ? 'Recent' : value === 'active' ? 'Active' : 'Needs attention'}
          </Button>
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary" role="status">
        Page {cursors.length} · Showing {visible.length} tasks in this view, up to {ACTIVITY_PAGE_SIZE} per page.
        {hasOlder
          ? ' Older matching tasks are available.'
          : !loading && !stale && !error
          ? ' No older matching tasks in this page snapshot.'
          : ''}
      </Typography>
      {error && <Alert severity="warning">{error}</Alert>}
      {stale && !loading && !error && <Alert severity="info">Reconnecting. Displayed status may be outdated.</Alert>}
      {loading && <Typography role="status">Loading activity…</Typography>}
      {!loading && visible.length === 0 && <Typography>No tasks in this view.</Typography>}
      {visible.map((job) => (
        <JobStatusPanel key={job.jobId} job={job} compact stale={stale} />
      ))}
      <Stack direction="row" gap={1} flexWrap="wrap" component="nav" aria-label="Activity pages">
        <Button
          variant="outlined"
          disabled={loading || cursors.length <= 1}
          onClick={() => setCursors((prior) => prior.slice(0, -1))}
        >
          Newer tasks
        </Button>
        <Button
          variant="outlined"
          disabled={loading || stale || Boolean(error) || !hasOlder || !olderCursor}
          onClick={() => {
            if (olderCursor) setCursors((prior) => [...prior, olderCursor]);
          }}
        >
          Older tasks
        </Button>
        {cursors.length > 1 && (
          <Button disabled={loading} onClick={() => setCursors([undefined])}>
            Latest tasks
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
ActivityPage.PageLayout = AppLayout;
