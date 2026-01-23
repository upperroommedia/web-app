/**
 * Skeleton for SermonListCard - matches the actual card layout
 */
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';

interface SermonListCardSkelotenProps {
  minimal?: boolean;
}

export default function SermonListCardSkeloten({ minimal = false }: SermonListCardSkelotenProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const isTablet = useMediaQuery(theme.breakpoints.up('sm'));
  
  const imageSize = isDesktop ? 150 : isTablet ? 90 : 64;

  return (
    <Card
      sx={{
        display: 'flex',
        flexDirection: 'row',
        cursor: 'pointer',
        overflow: 'hidden',
        mb: { xs: 1, sm: 1.5 },
        height: imageSize,
        width: '100%',
        position: 'relative',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          bgcolor: alpha(theme.palette.primary.main, 0.05),
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 0,
        },
        '&:hover::before': {
          opacity: 1,
        },
        '& > *': {
          position: 'relative',
          zIndex: 1,
        },
      }}
    >
      {/* Square Image */}
      <Skeleton variant="rectangular" sx={{ flexShrink: 0, width: imageSize, height: imageSize }} />

      {/* Content Area */}
      <Box 
        sx={{ 
          flex: 1, 
          minWidth: 0,
          display: 'flex', 
          flexDirection: 'row',
          p: { xs: 0.5, sm: 1, md: 1 }, 
          overflow: 'hidden',
        }}
      >
        {/* Text Content */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minHeight: 0, minWidth: 0, justifyContent: 'space-between' }}>
          {/* Title Row with Uploader Avatar */}
          <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', minWidth: 0, overflow: 'hidden', width: '100%' }}>
            <Stack gap={0.5} sx={{ flex: 1, minWidth: 0, width: 0, overflow: 'hidden' }}>
              {/* Title */}
              <Skeleton 
                variant="text" 
                sx={{ 
                  width: '70%', 
                  height: { xs: 12, sm: 12, md: 13, lg: 16 },
                  lineHeight: 1.2,
                }} 
              />
              {/* Speaker */}
              <Skeleton 
                variant="text" 
                sx={{ 
                  width: '40%', 
                  height: { xs: 10, sm: 11, md: 12 },
                  lineHeight: 1.2,
                }} 
              />
            </Stack>
            {/* Uploader Avatar - always visible */}
            <Skeleton 
              variant="circular" 
              sx={{ 
                flexShrink: 0,
                width: { xs: 20, sm: 24, md: 40 }, 
                height: { xs: 20, sm: 24, md: 40 } 
              }} 
            />
          </Box>

          {/* Description - Desktop only (3 lines) */}
          {isDesktop && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              <Skeleton variant="text" sx={{ width: '90%', height: 10, borderRadius: 1 }} />
              <Skeleton variant="text" sx={{ width: '85%', height: 10, borderRadius: 1 }} />
              <Skeleton variant="text" sx={{ width: '80%', height: 10, borderRadius: 1 }} />
            </Box>
          )}

          {/* Meta Row */}
          <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5, flexShrink: 0 }}>
            <Stack direction="row" spacing={0.5} alignItems="center" flex={1} sx={{ mt: 0.25, overflow: 'hidden', minWidth: 0 }}>
              {/* Play Button - Tablet only */}
              {isTablet && (
                <Skeleton variant="circular" sx={{ width: 30, height: 30, flexShrink: 0 }} />
              )}
              {/* Date */}
              <Skeleton variant="text" sx={{ width: { xs: 50, sm: 80 }, height: { xs: 10, sm: 12 }, whiteSpace: 'nowrap' }} />
              {/* Duration */}
              <Skeleton variant="text" sx={{ width: 30, height: { xs: 10, sm: 12 } }} />
              {/* Series Tag - Tablet only */}
              {isTablet && (
                <Skeleton 
                  variant="rounded" 
                  sx={{ 
                    width: 60, 
                    height: 18, 
                    borderRadius: 10,
                    flexShrink: 0,
                  }} 
                />
              )}
            </Stack>
            {/* Actions on right side */}
            <Stack direction="column" spacing={0.5} justifyContent="space-between" alignItems="center" flexShrink={0}>
              {/* Mobile Actions - SoundCloud, Subsplash, PlayButton in a row */}
              {!isTablet && !minimal && (
                <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5 }}>
                  <Skeleton variant="rounded" sx={{ width: 40, height: 22, borderRadius: 2 }} />
                  <Skeleton variant="rounded" sx={{ width: 40, height: 22, borderRadius: 2 }} />
                  <Skeleton variant="circular" sx={{ width: 20, height: 20 }} />
                </Box>
              )}
              {/* Desktop Actions - Only publishing chips (no play button) */}
              {isTablet && !minimal && (
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                  <Skeleton variant="rounded" sx={{ width: 40, height: 22, borderRadius: 2 }} />
                  <Skeleton variant="rounded" sx={{ width: 40, height: 22, borderRadius: 2 }} />
                </Stack>
              )}
            </Stack>
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
