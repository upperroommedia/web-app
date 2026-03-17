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
import { UploadProgress } from '../../context/types';
import { AudioSource } from '../../pages/api/uploadFile';
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
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
`;

const successPop = keyframes`
  0% { transform: scale(0.5); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
`;

interface UploadProgressComponentProps {
  audioSource: AudioSource | undefined;
  isUploading: boolean;
  uploadProgress: UploadProgress;
  sermon?: Sermon;
  isNavigatingToSermon?: boolean;
  onNavigateToSermon?: () => void;
  onDismiss?: () => void;
}

// Inspirational messages during upload stages
const getUploadMessage = (percent: number): string => {
  if (percent < 15) return 'Preparing your sermon...';
  if (percent < 30) return 'Processing audio...';
  if (percent < 50) return 'Uploading to the cloud...';
  if (percent < 70) return 'Almost there...';
  if (percent < 90) return 'Finalizing upload...';
  return 'Completing...';
};

export default function UploadProgressComponent({
  audioSource,
  isUploading,
  uploadProgress,
  sermon,
  isNavigatingToSermon = false,
  onNavigateToSermon,
  onDismiss,
}: UploadProgressComponentProps) {
  const theme = useTheme();
  const isIndeterminate = audioSource?.type === 'YoutubeUrl';
  const isComplete = uploadProgress.percent >= 100 && !uploadProgress.error;
  const isError = uploadProgress.error;

  // Modal is open when uploading or when complete/error with a message
  const isOpen = isUploading || (uploadProgress.message !== '' && (isComplete || isError));

  // Can dismiss when complete or error (not while actively uploading)
  const canDismiss = (isComplete || isError) && !isNavigatingToSermon;

  if (!isOpen) {
    return null;
  }

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
      aria-describedby={isError && uploadProgress.message ? 'upload-progress-dialog-description' : undefined}
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
          boxShadow: `0 24px 80px ${alpha(theme.palette.common.black, 0.25)}, 0 0 1px ${alpha(theme.palette.common.black, 0.1)}`,
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
        {isUploading && !isError && !isComplete && (
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

        <Box sx={{ position: 'relative', zIndex: 1, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
          <Box sx={{ minHeight: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
            <Typography
              id="upload-progress-dialog-title"
              variant="h5"
              fontWeight={700}
              sx={{
                color: isError ? 'error.main' : isComplete ? 'success.main' : 'text.primary',
                textAlign: 'center',
              }}
            >
              {isError
                ? 'Upload Failed'
                : isComplete
                  ? 'Upload Complete!'
                  : isIndeterminate
                    ? 'Processing YouTube...'
                    : getUploadMessage(uploadProgress.percent)}
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
            {isError && uploadProgress.message && (
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
                {uploadProgress.message}
              </Typography>
            )}
          </Box>

          {/* Progress Bar - Fixed width */}
          {isUploading && !isComplete && !isError && (
            <Box sx={{ width: '100%', maxWidth: 320 }}>
              {/* Progress track */}
              <Box
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
                    width: isIndeterminate ? '100%' : `${uploadProgress.percent}%`,
                    borderRadius: 5,
                    background: isIndeterminate
                      ? `linear-gradient(90deg, transparent, ${theme.palette.primary.main}, transparent)`
                      : `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})`,
                    backgroundSize: isIndeterminate ? '200% 100%' : '100% 100%',
                    animation: isIndeterminate ? `${shimmer} 1.5s ease-in-out infinite` : 'none',
                    transition: 'width 0.3s ease-out',
                    boxShadow: `0 0 12px ${alpha(theme.palette.primary.main, 0.5)}`,
                  }}
                >
                </Box>
              </Box>

              {/* Percentage */}
              {!isIndeterminate && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Typography
                    variant="h6"
                    fontWeight={700}
                    sx={{ color: 'primary.main', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {uploadProgress.percent}%
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          {/* Action buttons when complete */}
          {isComplete && onNavigateToSermon && (
            <Button
              variant="contained"
              size="large"
              endIcon={<ArrowForwardIcon />}
              onClick={onNavigateToSermon}
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
          {isError && (
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
