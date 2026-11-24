import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DurableJob } from '@upperroom/contracts/temporal';
import useAuth from '../../context/user/UserContext';
import { useDurableJob } from '../../hooks/useDurableJobs';
import { submitDurableCommand } from '../../utils/durableJobs';
import { jobStateLabel } from '../../utils/durableJobPresentation';
import { confirmedSermonAudioJob, getSermonProcessing } from '../../utils/sermonProcessing';

/** Familiar inline status and permitted cancellation, without an operational task card. */
export default function PlainJobStatus({ job, stale = false }: { job: DurableJob; stale?: boolean }) {
  const { user } = useAuth();
  const childId =
    job.kind === 'upload.create' && typeof job.result?.mediaJobId === 'string' ? job.result.mediaJobId : undefined;
  const child = useDurableJob(childId);
  const sourceReceived = job.kind === 'upload.create' && job.state === 'succeeded';
  const displayed = sourceReceived ? confirmedSermonAudioJob(job, child.job) : job;
  const outdated = stale || Boolean(childId && (child.stale || child.error));
  const step = displayed?.steps.find((item) => ['running', 'retrying', 'waiting'].includes(item.state));
  const progress =
    displayed?.kind === 'audio.process' ? getSermonProcessing([displayed], undefined, outdated).percent : undefined;
  const identity = displayed ? `${displayed.jobId}:${displayed.generation}:${displayed.revision}` : '';
  const [command, setCommand] = useState<{ identity: string; message: string }>();
  const currentCommand = command?.identity === identity ? command : undefined;
  const canCancel = Boolean(
    displayed?.actions.includes('cancel') && user && (user.isAdmin() || user.uid === displayed.requestedBy) && !outdated
  );
  const needsAttention = Boolean(
    displayed && ['failed', 'needs_attention', 'waiting_for_auth'].includes(displayed.state)
  );
  return (
    <Stack spacing={1} aria-label="Current request status">
      <Typography variant="body2" color="text.secondary" role="status" aria-live="polite">
        {sourceReceived && childId && !outdated ? 'Source received · ' : ''}
        {outdated ? 'Reconnecting…' : displayed ? jobStateLabel(displayed) : 'Waiting for audio processing status'}
        {step && !outdated ? ` · ${step.label}` : ''}
        {progress !== undefined ? ` · ${progress}%` : ''}
      </Typography>
      {progress !== undefined && (
        <LinearProgress aria-label="Audio processing" variant="determinate" value={progress} />
      )}
      {outdated && <Alert severity="info">Reconnecting. Displayed status may be outdated.</Alert>}
      {needsAttention && (
        <Alert severity="warning">
          {displayed?.attention?.message ||
            displayed?.error?.message ||
            'This request needs attention before it can continue.'}
        </Alert>
      )}
      {canCancel && displayed && (
        <Button
          disabled={Boolean(currentCommand)}
          size="small"
          sx={{ alignSelf: 'flex-start' }}
          onClick={async () => {
            setCommand({ identity, message: 'Requesting cancellation…' });
            try {
              await submitDurableCommand(displayed, 'cancel');
              setCommand({ identity, message: 'Cancellation requested. Waiting for confirmation.' });
            } catch (error) {
              setCommand({
                identity,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Cancellation could not be confirmed. Wait for updated status before trying again.',
              });
            }
          }}
        >
          Request cancellation
        </Button>
      )}
      {currentCommand && (
        <Typography variant="body2" role="status">
          {currentCommand.message}
        </Typography>
      )}
    </Stack>
  );
}
