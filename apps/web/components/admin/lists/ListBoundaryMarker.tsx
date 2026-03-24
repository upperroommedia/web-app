import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import type { ListOverflowChainBoundaryMarker } from '../../../utils/lists/listOverflowChainView';

interface ListBoundaryMarkerProps {
  marker: ListOverflowChainBoundaryMarker;
}

const ListBoundaryMarker = ({ marker }: ListBoundaryMarkerProps) => {
  const theme = useTheme();
  const coverageLabel =
    marker.missingMirroredCount > 0
      ? `${marker.localCount}/${marker.physicalCount} mirrored locally`
      : `${marker.physicalCount} mirrored locally`;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        bgcolor: alpha(theme.palette.info.main, 0.05),
        borderTop: `1px dashed ${alpha(theme.palette.info.main, 0.25)}`,
        borderBottom: `1px dashed ${alpha(theme.palette.info.main, 0.2)}`,
      }}
    >
      <Chip
        label={`Overflow page ${marker.sourceDepth}`}
        size="small"
        color="info"
        variant="outlined"
      />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {marker.sourceListName}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {coverageLabel}
      </Typography>
    </Box>
  );
};

export default ListBoundaryMarker;
