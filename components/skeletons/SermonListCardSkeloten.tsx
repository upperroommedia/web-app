/**
 * Skeleton for SermonListCard - matches the actual card layout
 */
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

interface SermonListCardSkelotenProps {
  minimal?: boolean;
}

export default function SermonListCardSkeloten({ minimal = false }: SermonListCardSkelotenProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const isTablet = useMediaQuery(theme.breakpoints.up('sm'));
  
  const imageSize = isDesktop ? 100 : isTablet ? 90 : 64;

  return (
    <Card
      sx={{
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden',
        mb: { xs: 1, sm: 1.5 },
        height: imageSize,
        width: '100%',
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
          p: { xs: 0.5, sm: 1, md: 1.5 }, 
          overflow: 'hidden',
        }}
      >
        {/* Text Content */}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {/* Title */}
          <Skeleton variant="text" sx={{ width: '70%', height: { xs: 14, sm: 18 } }} />
          {/* Speaker */}
          <Skeleton variant="text" sx={{ width: '40%', height: { xs: 10, sm: 14 } }} />
          {/* Meta */}
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
            <Skeleton variant="text" sx={{ width: 50, height: { xs: 10, sm: 12 } }} />
            <Skeleton variant="text" sx={{ width: 30, height: { xs: 10, sm: 12 } }} />
          </Stack>

          {/* Desktop: Actions at bottom */}
          {isTablet && !minimal && (
            <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="space-between" sx={{ mt: 0.5 }}>
              <Skeleton variant="circular" sx={{ width: 30, height: 30 }} />
              <Stack direction="row" spacing={0.5}>
                <Skeleton variant="rounded" sx={{ width: 50, height: 22, borderRadius: 2 }} />
                <Skeleton variant="rounded" sx={{ width: 50, height: 22, borderRadius: 2 }} />
              </Stack>
            </Stack>
          )}
        </Box>

        {/* Mobile: Actions on right side */}
        {!isTablet && !minimal && (
          <Stack direction="column" spacing={0.5} alignItems="center" sx={{ flexShrink: 0, ml: 0.5 }}>
            <Skeleton variant="circular" sx={{ width: 24, height: 24 }} />
            <Skeleton variant="circular" sx={{ width: 20, height: 20 }} />
            <Skeleton variant="rounded" sx={{ width: 24, height: 20, borderRadius: 10 }} />
          </Stack>
        )}

        {/* Uploader Avatar - tablet+ */}
        {isTablet && (
          <Skeleton variant="circular" sx={{ width: 24, height: 24, flexShrink: 0, ml: 1 }} />
        )}
      </Box>
    </Card>
  );
}
