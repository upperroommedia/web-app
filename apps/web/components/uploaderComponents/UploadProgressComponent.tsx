import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import type { DurableAdmissionReceipt, DurableJob } from '@upperroom/contracts/temporal';
import { AudioSource, AudioTransferProgress } from '../../utils/uploadFile';
import { Sermon } from '../../types/SermonTypes';
import { useDurableJob } from '../../hooks/useDurableJobs';
import JobStatusPanel from '../jobs/JobStatusPanel';

interface UploadProgressComponentProps {
  audioSource: AudioSource | undefined;
  /** Local submission/file transfer only; never remote audio processing. */
  isUploading: boolean;
  uploadProgress: AudioTransferProgress;
  receipt?: DurableAdmissionReceipt;
  sermon?: Sermon;
  isNavigatingToSermon?: boolean;
  onNavigateToSermon?: (sermonId?: string) => void;
  onDismiss?: () => void;
  requesterUid?: string;
  onRetrySource?: (job: DurableJob) => void;
}

export default function UploadProgressComponent({
  audioSource,
  isUploading,
  uploadProgress,
  receipt,
  sermon,
  isNavigatingToSermon = false,
  onNavigateToSermon,
  onDismiss,
  requesterUid,
  onRetrySource,
}: UploadProgressComponentProps) {
  const { job, error, stale } = useDurableJob(receipt?.jobId);
  const isOpen = isUploading || Boolean(receipt) || uploadProgress.error;
  const canDismiss = !isUploading && !isNavigatingToSermon;
  const fileTransfer = isUploading && audioSource?.type === 'File' && uploadProgress.phase === 'transferring';
  const percent = Math.max(0, Math.min(100, uploadProgress.percent));
  const canRetrySource = Boolean(
    job?.kind === 'upload.create' &&
      ['cancelled', 'failed', 'superseded'].includes(job.state) &&
      requesterUid &&
      job.requestedBy === requesterUid &&
      audioSource &&
      !job.result?.mediaJobId &&
      !job.result?.mediaJobRef &&
      !stale &&
      !error &&
      !isUploading &&
      !isNavigatingToSermon &&
      onRetrySource
  );
  return (
    <Dialog
      open={isOpen}
      onClose={canDismiss ? onDismiss : undefined}
      disableEscapeKeyDown={!canDismiss}
      fullWidth
      maxWidth="sm"
      aria-labelledby="upload-progress-dialog-title"
    >
      <DialogTitle id="upload-progress-dialog-title">
        {isUploading
          ? uploadProgress.phase === 'checking'
            ? 'Checking audio source'
            : fileTransfer
            ? 'Sending audio file'
            : uploadProgress.phase === 'confirming'
            ? 'Confirming file transfer'
            : 'Saving upload request'
          : receipt
          ? 'Upload activity'
          : 'Upload needs attention'}
      </DialogTitle>
      <DialogContent>
        {sermon && <Typography sx={{ mb: 2 }}>{sermon.title}</Typography>}
        {isUploading && (
          <Box sx={{ my: 2 }}>
            <LinearProgress
              aria-label={fileTransfer ? 'Audio file transfer' : 'Saving upload request'}
              variant={fileTransfer ? 'determinate' : 'indeterminate'}
              value={fileTransfer ? percent : undefined}
            />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {fileTransfer ? `File transfer: ${percent}%` : uploadProgress.message}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {fileTransfer
                ? 'Keep this tab open until the file finishes transferring.'
                : 'Processing begins after your request is saved.'}
            </Typography>
          </Box>
        )}
        {uploadProgress.error && (
          <Alert severity="warning" sx={{ my: 2 }}>
            {canRetrySource
              ? 'This audio attempt stopped. You can start a new attempt with the same saved source.'
              : uploadProgress.message}
          </Alert>
        )}
        {(stale || error) && (
          <Alert severity="info" sx={{ my: 2 }}>
            Reconnecting. The displayed activity may be out of date.
          </Alert>
        )}
        {job ? (
          <JobStatusPanel job={job} stale={stale || Boolean(error)} showEntityLink={false} />
        ) : (
          receipt && <Alert severity="info">Your request is saved. Waiting for its latest status.</Alert>
        )}
        {canRetrySource && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Try this upload again with the same audio and saved settings. Your sermon details and lists will be kept.
          </Alert>
        )}
        {receipt && !isUploading && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {job?.state === 'awaiting_source'
              ? 'Your upload request is saved, but audio processing waits for the original file. You can resume the file transfer from Activity.'
              : 'You can leave this page. Follow processing in Activity or on the sermon. Saving a request does not mean audio processing is complete.'}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {canDismiss && <Button onClick={onDismiss}>Close</Button>}
        {canRetrySource && job && (
          <Button variant="outlined" onClick={() => onRetrySource?.(job)}>
            Try upload again
          </Button>
        )}
        {receipt && !isUploading && onNavigateToSermon && (
          <Button
            variant="contained"
            onClick={() => onNavigateToSermon(job?.entity.id)}
            disabled={isNavigatingToSermon || job?.entity.type !== 'sermon'}
          >
            {isNavigatingToSermon ? 'Opening sermon…' : 'View sermon'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
