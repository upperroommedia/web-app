import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Dialog, { DialogProps } from '@mui/material/Dialog';
import { alpha, useTheme, keyframes } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import CloseIcon from '@mui/icons-material/Close';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import type { DurableAdmissionReceipt, DurableJob } from '@upperroom/contracts/temporal';
import { AudioSource, AudioTransferProgress } from '../../utils/uploadFile';
import { useDurableJob } from '../../hooks/useDurableJobs';
import useAuth from '../../context/user/UserContext';
import { submitDurableCommand } from '../../utils/durableJobs';
import { JOB_STATE_LABELS } from '../../utils/durableJobPresentation';
import { Sermon } from '../../types/SermonTypes';
import AvatarWithDefaultImage from '../AvatarWithDefaultImage';

// Animations
const pulse = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.05); }
`;

const flicker = keyframes`
  0%, 100% { opacity: 1; }
  25% { opacity: 0.8; }
  50% { opacity: 1; }
  75% { opacity: 0.9; }
`;

const rise = keyframes`
  0% { transform: translateY(0) scale(1); opacity: 0.8; }
  100% { transform: translateY(-20px) scale(0.8); opacity: 0; }
`;

const shimmer = keyframes`
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
`;

const successPop = keyframes`
  0% { transform: scale(0.5); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
`;

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
  const theme = useTheme();
  const { user } = useAuth();
  const source = useDurableJob(receipt?.jobId);
  const job = source.job;
  const childId =
    job?.kind === 'upload.create' && typeof job.result?.mediaJobId === 'string' ? job.result.mediaJobId : undefined;
  const audio = useDurableJob(childId);
  const sourceReceived = job?.kind === 'upload.create' && job.state === 'succeeded';
  const currentJob = sourceReceived ? audio.job : job;
  const stale =
    Boolean(receipt?.jobId && (source.stale || source.error)) || Boolean(childId && (audio.stale || audio.error));
  const isComplete = Boolean(
    !isUploading &&
      sourceReceived &&
      audio.job?.kind === 'audio.process' &&
      audio.job.state === 'succeeded' &&
      !stale &&
      !uploadProgress.error
  );
  const isError = Boolean(
    uploadProgress.error || (currentJob && ['failed', 'needs_attention', 'waiting_for_auth'].includes(currentJob.state))
  );
  const stopped = Boolean(currentJob && ['cancelled', 'superseded'].includes(currentJob.state));
  const fileTransfer = isUploading && audioSource?.type === 'File' && uploadProgress.phase === 'transferring';
  const isIndeterminate = !fileTransfer;
  const percent = Number.isFinite(uploadProgress.percent) ? Math.max(0, Math.min(100, uploadProgress.percent)) : 0;
  const isOpen = isUploading || Boolean(receipt) || uploadProgress.error;
  const canDismiss = !isUploading && !isNavigatingToSermon;
  const showProgress = !isComplete && !isError && !stopped;
  const statusTitle = stale
    ? 'Reconnecting...'
    : stopped
    ? 'Upload stopped'
    : isUploading
    ? uploadProgress.phase === 'checking'
      ? 'Preparing your sermon...'
      : fileTransfer
      ? 'Uploading audio...'
      : uploadProgress.phase === 'confirming'
      ? 'Confirming file transfer...'
      : 'Saving your upload...'
    : currentJob
    ? currentJob.steps.find((step) => ['running', 'retrying', 'waiting'].includes(step.state))?.label ??
      (currentJob.state === 'running' ? 'Processing audio...' : JOB_STATE_LABELS[currentJob.state])
    : sourceReceived
    ? 'Preparing audio processing...'
    : 'Checking upload status...';
  const canNavigate = Boolean(receipt && !isUploading && job?.entity.type === 'sermon' && onNavigateToSermon);
  const canRetrySource = Boolean(
    job?.kind === 'upload.create' &&
      ['cancelled', 'failed', 'superseded'].includes(job.state) &&
      requesterUid &&
      job.requestedBy === requesterUid &&
      audioSource &&
      !job.result?.mediaJobId &&
      !job.result?.mediaJobRef &&
      !stale &&
      !isUploading &&
      !isNavigatingToSermon &&
      onRetrySource
  );
  const commandIdentity = currentJob ? `${currentJob.jobId}:${currentJob.generation}:${currentJob.revision}` : '';
  const [command, setCommand] = useState<{ identity: string; message: string }>();
  const currentCommand = command?.identity === commandIdentity ? command : undefined;
  const canCancel = Boolean(
    currentJob?.actions.includes('cancel') &&
      (user?.isAdmin() || currentJob.requestedBy === requesterUid) &&
      !stale &&
      !isUploading &&
      !isNavigatingToSermon
  );

  if (!isOpen) return null;

  const sermonImage = sermon?.images?.find((img) => img.type === 'square');

  const handleClose: NonNullable<DialogProps['onClose']> = (_event, _reason) => {
    if (canDismiss && onDismiss) {
      onDismiss();
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={handleClose}
      aria-labelledby="upload-progress-dialog-title"
      aria-describedby={isError ? 'upload-progress-dialog-description' : undefined}
      disableEscapeKeyDown={!canDismiss}
      maxWidth={false}
      sx={{
        '& .MuiBackdrop-root': {
          backgroundColor: alpha(theme.palette.background.default, 0.6),
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          cursor: canDismiss ? 'pointer' : 'default',
        },
        '& .MuiDialog-paper': {
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          minHeight: 320,
          bgcolor: 'background.paper',
          borderRadius: 4,
          boxShadow: `0 24px 80px ${alpha(theme.palette.common.black, 0.25)}, 0 0 1px ${alpha(
            theme.palette.common.black,
            0.1
          )}`,
          p: 4,
          outline: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
          cursor: 'default',
          backgroundImage: 'none',
          m: 3,
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Close button - only show when dismissable */}
        {canDismiss && onDismiss && (
          <IconButton
            onClick={onDismiss}
            sx={{
              position: 'absolute',
              top: -12,
              right: -12,
              color: 'text.secondary',
              '&:hover': {
                color: 'text.primary',
                bgcolor: alpha(theme.palette.text.primary, 0.08),
              },
            }}
            size="small"
            aria-label="Close upload status dialog"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}

        {/* Background glow effect */}
        {showProgress && (
          <Box
            sx={{
              position: 'absolute',
              top: '30%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 200,
              height: 200,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${alpha(theme.palette.primary.main, 0.15)} 0%, transparent 70%)`,
              animation: `${pulse} 2s ease-in-out infinite`,
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Success glow */}
        {isComplete && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 300,
              height: 300,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${alpha(theme.palette.success.main, 0.12)} 0%, transparent 60%)`,
              pointerEvents: 'none',
            }}
          />
        )}

        <Box
          sx={{
            position: 'relative',
            zIndex: 1,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {/* Icon Container - Fixed size to prevent layout shift */}
          <Box
            sx={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 100,
              height: 100,
              mb: 3,
            }}
          >
            {isError ? (
              <ErrorOutlineIcon
                sx={{
                  fontSize: 72,
                  color: 'error.main',
                  animation: `${pulse} 1s ease-in-out`,
                }}
              />
            ) : isComplete ? (
              <Box
                sx={{
                  animation: `${successPop} 0.5s ease-out`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                }}
              >
                {/* Sermon thumbnail */}
                {sermonImage ? (
                  <Box sx={{ position: 'relative' }}>
                    <AvatarWithDefaultImage
                      width={100}
                      height={100}
                      borderRadius={16}
                      altName={sermon?.title || 'Sermon'}
                      image={sermonImage}
                    />
                    <CheckCircleIcon
                      sx={{
                        position: 'absolute',
                        bottom: -6,
                        right: -6,
                        fontSize: 32,
                        color: 'success.main',
                        bgcolor: 'background.paper',
                        borderRadius: '50%',
                      }}
                    />
                  </Box>
                ) : (
                  <CheckCircleIcon
                    sx={{
                      fontSize: 72,
                      color: 'success.main',
                    }}
                  />
                )}
              </Box>
            ) : (
              <>
                {/* Flame particles rising */}
                {[...Array(3)].map((_, i) => (
                  <LocalFireDepartmentIcon
                    key={i}
                    sx={{
                      position: 'absolute',
                      fontSize: 20,
                      color: alpha(theme.palette.primary.main, 0.6),
                      animation: `${rise} ${1.5 + i * 0.3}s ease-out infinite`,
                      animationDelay: `${i * 0.4}s`,
                      left: `${25 + i * 20}%`,
                      top: 0,
                    }}
                  />
                ))}
                {/* Main flame icon */}
                <LocalFireDepartmentIcon
                  sx={{
                    fontSize: 72,
                    color: 'primary.main',
                    animation: `${flicker} 1.5s ease-in-out infinite`,
                    filter: `drop-shadow(0 0 12px ${alpha(theme.palette.primary.main, 0.5)})`,
                  }}
                />
              </>
            )}
          </Box>

          {/* Status Text - Fixed height container */}
          <Box
            sx={{
              minHeight: 60,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              mb: 2,
            }}
          >
            <Typography
              id="upload-progress-dialog-title"
              variant="h5"
              fontWeight={700}
              sx={{
                color: isError ? 'error.main' : isComplete ? 'success.main' : 'text.primary',
                textAlign: 'center',
              }}
            >
              {isError ? 'Upload needs attention' : isComplete ? 'Upload Complete!' : statusTitle}
            </Typography>

            {/* Sermon title when complete */}
            {isComplete && sermon && (
              <Typography
                variant="body1"
                sx={{
                  color: 'text.secondary',
                  textAlign: 'center',
                  mt: 1,
                  fontWeight: 500,
                }}
              >
                {sermon.title}
              </Typography>
            )}

            {/* Error message */}
            {isError && (
              <Typography
                id="upload-progress-dialog-description"
                variant="body2"
                sx={{
                  color: 'error.dark',
                  textAlign: 'center',
                  mt: 1,
                  maxWidth: 350,
                }}
              >
                {canRetrySource
                  ? 'This audio attempt stopped. You can start a new attempt with the same saved source.'
                  : uploadProgress.error
                  ? uploadProgress.message
                  : currentJob?.error?.message || 'Your upload needs attention before it can continue.'}
              </Typography>
            )}
          </Box>

          {/* Progress Bar - Fixed width */}
          {showProgress && (
            <Box sx={{ width: '100%', maxWidth: 320 }}>
              {/* Progress track */}
              <Box
                role="progressbar"
                aria-label={fileTransfer ? 'Audio file transfer' : 'Audio processing'}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fileTransfer ? percent : undefined}
                sx={{
                  position: 'relative',
                  height: 10,
                  borderRadius: 5,
                  bgcolor: alpha(theme.palette.primary.main, 0.1),
                  overflow: 'hidden',
                }}
              >
                {/* Progress fill */}
                <Box
                  sx={{
                    position: 'relative',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: isIndeterminate ? '100%' : `${percent}%`,
                    borderRadius: 5,
                    background: isIndeterminate
                      ? `linear-gradient(90deg, transparent, ${theme.palette.primary.main}, transparent)`
                      : `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})`,
                    backgroundSize: isIndeterminate ? '200% 100%' : '100% 100%',
                    animation: isIndeterminate ? `${shimmer} 1.5s ease-in-out infinite` : 'none',
                    transition: 'width 0.3s ease-out',
                    boxShadow: `0 0 12px ${alpha(theme.palette.primary.main, 0.5)}`,
                  }}
                ></Box>
              </Box>

              {/* Percentage */}
              {!isIndeterminate && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Typography
                    variant="h6"
                    fontWeight={700}
                    sx={{ color: 'primary.main', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {percent}%
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          {stale && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Reconnecting. Displayed status may be outdated.
            </Alert>
          )}
          {receipt && !isUploading && !isComplete && !stale && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }} role="status">
              {job?.state === 'awaiting_source'
                ? 'Keep the original audio file available. Its transfer still needs to finish.'
                : sourceReceived
                ? 'Source received. You can follow audio processing on the sermon page.'
                : 'Your upload is saved. You can follow its progress on the sermon page.'}
            </Typography>
          )}
          {canRetrySource && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
              Try this upload again with the same audio and saved settings. Your sermon details and lists will be kept.
            </Typography>
          )}
          {canRetrySource && job && (
            <Button variant="outlined" sx={{ mt: 2 }} onClick={() => onRetrySource?.(job)}>
              Try upload again
            </Button>
          )}
          {canCancel && currentJob && (
            <Button
              sx={{ mt: 2 }}
              disabled={Boolean(currentCommand)}
              onClick={async () => {
                setCommand({ identity: commandIdentity, message: 'Requesting cancellation...' });
                try {
                  await submitDurableCommand(currentJob, 'cancel');
                  setCommand({
                    identity: commandIdentity,
                    message: 'Cancellation requested. Waiting for confirmation.',
                  });
                } catch (error) {
                  setCommand({
                    identity: commandIdentity,
                    message:
                      error instanceof Error
                        ? error.message
                        : 'Cancellation could not be confirmed. Wait for refreshed status before trying again.',
                  });
                }
              }}
            >
              Request cancellation
            </Button>
          )}
          {currentCommand && (
            <Typography variant="body2" role="status" sx={{ mt: 1 }}>
              {currentCommand.message}
            </Typography>
          )}

          {/* Action buttons when complete */}
          {canNavigate && (
            <Button
              variant="contained"
              size="large"
              endIcon={<ArrowForwardIcon />}
              onClick={() => onNavigateToSermon?.(job?.entity.id)}
              disabled={isNavigatingToSermon}
              sx={{
                mt: 3,
                px: 4,
                py: 1.5,
                borderRadius: 3,
                fontWeight: 600,
                textTransform: 'none',
                fontSize: '1rem',
                boxShadow: `0 4px 20px ${alpha(theme.palette.primary.main, 0.35)}`,
                '&:hover': {
                  boxShadow: `0 6px 24px ${alpha(theme.palette.primary.main, 0.45)}`,
                },
              }}
            >
              {isNavigatingToSermon ? 'Opening Sermon...' : 'View Sermon'}
            </Button>
          )}

          {/* Dismiss hint for errors */}
          {isError && canDismiss && (
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                mt: 2,
              }}
            >
              Click anywhere to dismiss
            </Typography>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}
