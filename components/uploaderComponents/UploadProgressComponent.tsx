import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import { alpha, useTheme, keyframes } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import { UploadProgress } from '../../context/types';
import { AudioSource } from '../../pages/api/uploadFile';

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

interface UploadProgressComponentProps {
  audioSource: AudioSource | undefined;
  isUploading: boolean;
  uploadProgress: UploadProgress;
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
}: UploadProgressComponentProps) {
  const theme = useTheme();
  const isIndeterminate = audioSource?.type === 'YoutubeUrl';
  const isComplete = uploadProgress.percent >= 100 && !uploadProgress.error;
  const isError = uploadProgress.error;

  // Don't show anything if not uploading and no message
  if (!isUploading && !uploadProgress.message) {
    return null;
  }

  return (
    <Card
      sx={{
        mt: 3,
        p: 3,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: isError 
          ? alpha(theme.palette.error.main, 0.05)
          : isComplete 
            ? alpha(theme.palette.success.main, 0.05)
            : alpha(theme.palette.primary.main, 0.03),
        border: '1px solid',
        borderColor: isError 
          ? alpha(theme.palette.error.main, 0.2)
          : isComplete
            ? alpha(theme.palette.success.main, 0.2)
            : alpha(theme.palette.primary.main, 0.15),
        transition: 'all 0.3s ease',
      }}
    >
      {/* Background glow effect */}
      {isUploading && !isError && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
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

      <Box sx={{ position: 'relative', zIndex: 1 }}>
        {/* Icon and Status */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 2 }}>
          {/* Animated Icon */}
          <Box
            sx={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 64,
              height: 64,
              mb: 2,
            }}
          >
            {isError ? (
              <ErrorOutlineIcon
                sx={{
                  fontSize: 48,
                  color: 'error.main',
                  animation: `${pulse} 1s ease-in-out`,
                }}
              />
            ) : isComplete ? (
              <CheckCircleIcon
                sx={{
                  fontSize: 48,
                  color: 'success.main',
                  animation: `${pulse} 0.5s ease-out`,
                }}
              />
            ) : (
              <>
                {/* Flame particles rising */}
                {[...Array(3)].map((_, i) => (
                  <LocalFireDepartmentIcon
                    key={i}
                    sx={{
                      position: 'absolute',
                      fontSize: 16,
                      color: alpha(theme.palette.primary.main, 0.6),
                      animation: `${rise} ${1.5 + i * 0.3}s ease-out infinite`,
                      animationDelay: `${i * 0.4}s`,
                      left: `${30 + i * 15}%`,
                    }}
                  />
                ))}
                {/* Main flame icon */}
                <LocalFireDepartmentIcon
                  sx={{
                    fontSize: 48,
                    color: 'primary.main',
                    animation: `${flicker} 1.5s ease-in-out infinite`,
                    filter: `drop-shadow(0 0 8px ${alpha(theme.palette.primary.main, 0.5)})`,
                  }}
                />
              </>
            )}
          </Box>

          {/* Status Text */}
          <Typography
            variant="h6"
            fontWeight={600}
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
                  ? 'Processing YouTube Video...'
                  : getUploadMessage(uploadProgress.percent)}
          </Typography>

          {/* Subtext / Message */}
          {uploadProgress.message && (
            <Typography
              variant="body2"
              sx={{
                color: isError ? 'error.dark' : 'text.secondary',
                textAlign: 'center',
                mt: 0.5,
                maxWidth: 400,
              }}
            >
              {uploadProgress.message}
            </Typography>
          )}
        </Box>

        {/* Progress Bar */}
        {isUploading && !isComplete && (
          <Box sx={{ mt: 2 }}>
            {/* Progress track */}
            <Box
              sx={{
                position: 'relative',
                height: 8,
                borderRadius: 4,
                bgcolor: alpha(theme.palette.primary.main, 0.1),
                overflow: 'hidden',
              }}
            >
              {/* Progress fill */}
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: '100%',
                  width: isIndeterminate ? '100%' : `${uploadProgress.percent}%`,
                  borderRadius: 4,
                  background: isIndeterminate
                    ? `linear-gradient(90deg, transparent, ${theme.palette.primary.main}, transparent)`
                    : `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})`,
                  backgroundSize: isIndeterminate ? '200% 100%' : '100% 100%',
                  animation: isIndeterminate ? `${shimmer} 1.5s ease-in-out infinite` : 'none',
                  transition: 'width 0.3s ease-out',
                  boxShadow: `0 0 10px ${alpha(theme.palette.primary.main, 0.5)}`,
                }}
              />
            </Box>

            {/* Percentage */}
            {!isIndeterminate && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Uploading sermon...
                </Typography>
                <Typography
                  variant="caption"
                  fontWeight={600}
                  sx={{ color: 'primary.main' }}
                >
                  {uploadProgress.percent}%
                </Typography>
              </Box>
            )}
          </Box>
        )}

      </Box>
    </Card>
  );
}
