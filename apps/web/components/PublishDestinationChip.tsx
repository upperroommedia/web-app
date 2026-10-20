import type { FunctionComponent, ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { alpha, useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { Series } from '../types/Series';
import type { PublishDestinationState } from '../utils/sermonPublishingUi';

// Keep the established destination presentation from main independent of task execution.
const getStatusTone = (
  state: PublishDestinationState,
  theme: Theme
): {
  sx: Record<string, unknown>;
} => {
  switch (state.state) {
    case 'published':
      return {
        sx: {
          bgcolor: alpha(theme.palette.success.main, 0.12),
          border: `1px solid ${alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.14 : 0.12)}`,
          color: theme.palette.success.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.success.main },
        },
      };
    case 'publishing':
      return {
        sx: {
          bgcolor: alpha(theme.palette.info.main, 0.12),
          border: `1px solid ${alpha(theme.palette.info.main, theme.palette.mode === 'dark' ? 0.14 : 0.12)}`,
          color: theme.palette.info.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.info.main },
        },
      };
    case 'checking':
      return {
        sx: {
          bgcolor:
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.12)
              : alpha(theme.palette.common.black, 0.06),
          border: `1px solid ${alpha(theme.palette.divider, theme.palette.mode === 'dark' ? 0.18 : 0.24)}`,
          color: theme.palette.text.secondary,
          '& .MuiChip-deleteIcon': { color: theme.palette.text.secondary },
        },
      };
    case 'partial':
    case 'blocked':
      return {
        sx: {
          bgcolor: alpha(theme.palette.warning.main, 0.14),
          border: `1px solid ${alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.14 : 0.12)}`,
          color: theme.palette.warning.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.warning.main },
        },
      };
    case 'error':
      return {
        sx: {
          bgcolor: alpha(theme.palette.error.main, 0.12),
          border: `1px solid ${alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.14 : 0.12)}`,
          color: theme.palette.error.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.error.main },
        },
      };
    default:
      return {
        sx: {
          bgcolor:
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.1)
              : alpha(theme.palette.common.black, 0.045),
          border: `1px solid ${alpha(theme.palette.divider, theme.palette.mode === 'dark' ? 0.16 : 0.22)}`,
          color: theme.palette.text.secondary,
          '& .MuiChip-deleteIcon': { color: theme.palette.text.secondary },
        },
      };
  }
};

const StatusChip: FunctionComponent<{
  label: ReactNode;
  status: PublishDestinationState;
  avatar?: ReactElement;
  tooltip?: ReactNode;
}> = ({ label, status, avatar, tooltip }) => {
  const theme = useTheme();
  const tone = getStatusTone(status, theme);
  const chip = (
    <Chip
      avatar={avatar}
      label={label}
      variant="filled"
      sx={{
        height: { xs: 28, sm: 32 },
        borderRadius: 999,
        pl: avatar ? { xs: '3px', sm: '4px' } : undefined,
        fontWeight: 700,
        transition: theme.transitions.create(['background-color', 'border-color', 'box-shadow']),
        '& .MuiChip-label': {
          fontSize: { xs: '0.72rem', sm: '0.78rem' },
          px: avatar ? { xs: '6px', sm: '8px' } : { xs: '8px', sm: '10px' },
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
        '& .MuiChip-avatar': {
          ml: 0,
          mr: { xs: '3px', sm: '4px' },
          width: { xs: 22, sm: 24 },
          height: { xs: 22, sm: 24 },
        },
        ...tone.sx,
      }}
    />
  );

  if (!tooltip) {
    return chip;
  }

  return (
    <Tooltip title={tooltip} arrow>
      <span>{chip}</span>
    </Tooltip>
  );
};

const SOUNDCLOUD_CLOUDMARK_WHITE_TRANSPARENT =
  'https://cdn.prod.website-files.com/62a0a0168756b795debc65bc/6862469207e5d6b29127bc31_791ac3ab0dddebdbe93c67a87e9cdd28_cloudmark-white-transparent.png';
const SOUNDCLOUD_CLOUDMARK_BLACK_TRANSPARENT =
  'https://cdn.prod.website-files.com/62a0a0168756b795debc65bc/686246aab0ebdf5a75a453df_cloudmark-black-transparent.png';

export const SoundCloudChipAvatar = () => {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const badgeColor = isDarkMode ? theme.palette.common.black : theme.palette.common.white;
  const logoSrc = isDarkMode ? SOUNDCLOUD_CLOUDMARK_WHITE_TRANSPARENT : SOUNDCLOUD_CLOUDMARK_BLACK_TRANSPARENT;

  return (
    <Box
      sx={{
        width: { xs: 22, sm: 24 },
        height: { xs: 22, sm: 24 },
        borderRadius: 999,
        bgcolor: badgeColor,
        border: `1px solid ${alpha(theme.palette.divider, isDarkMode ? 0.35 : 0.7)}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Box
        component="img"
        src={logoSrc}
        alt=""
        sx={{
          width: '72%',
          height: '72%',
          objectFit: 'contain',
          display: 'block',
        }}
      />
    </Box>
  );
};

export const getSeriesAvatarImage = (series: Series | null): Series['images'][number] | undefined =>
  series?.images?.find((image) => image.type === 'wide') ||
  series?.images?.find((image) => image.type === 'banner') ||
  series?.images?.find((image) => image.type === 'square');

export const ExternalDestinationLink: FunctionComponent<{ href: string; label: string }> = ({ href, label }) => (
  <Box
    component="a"
    href={href}
    target="_blank"
    rel="noreferrer"
    aria-label={label}
    onClick={(event) => {
      event.stopPropagation();
    }}
    sx={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'inherit',
      opacity: 0.8,
      textDecoration: 'none',
      '&:hover': {
        opacity: 1,
      },
    }}
  >
    <OpenInNewIcon sx={{ fontSize: { xs: 12, sm: 14 } }} />
  </Box>
);

export default StatusChip;
