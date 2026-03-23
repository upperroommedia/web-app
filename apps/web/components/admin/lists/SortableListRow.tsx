import { memo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import PendingIcon from '@mui/icons-material/Pending';
import { alpha, useTheme } from '@mui/material/styles';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import AvatarWithDefaultImage from '../../AvatarWithDefaultImage';
import type { ImageType } from '../../../types/Image';

export type SortableListRowViewModel = {
  id: string;
  rowId?: string;
  title: string;
  dateString?: string;
  speakerSummary?: string;
  rowTypeLabel?: string;
  statusLabel: 'Synced' | 'Subsplash only' | 'Local only';
  statusColor: 'success' | 'warning' | 'default';
  statusVariant: 'filled' | 'outlined';
  preferredImage?: ImageType;
  isTrackedInFirebase: boolean;
  isPlaceholder: boolean;
  isSyncedToList: boolean;
  isOverflowCandidate: boolean;
  rowNavigationDisabled: boolean;
  reconstructible: boolean;
  physicalListTagLabel?: string;
  sourceDepth: number;
};

type SortableListRowProps = {
  item: SortableListRowViewModel;
  index: number;
  dragDisabled?: boolean;
  overflowMarkDisabled?: boolean;
  overflowMarkLoading?: boolean;
  placementDirty?: boolean;
  showPhysicalPlacement?: boolean;
  onOpenSermon: (id: string) => void;
  onMarkOverflow?: (rowId: string) => void;
  showDivider?: boolean;
};

type ListRowContentProps = Omit<
  SortableListRowProps,
  'dragDisabled' | 'onOpenSermon' | 'showDivider'
> & {
  isDragging: boolean;
  dragHandleAttributes: object;
  dragHandleListeners: object | undefined;
  onRowClick: () => void;
};

const ListRowContent = memo(function ListRowContent({
  item,
  index,
  overflowMarkDisabled = false,
  overflowMarkLoading = false,
  placementDirty = false,
  showPhysicalPlacement = false,
  isDragging,
  dragHandleAttributes,
  dragHandleListeners,
  onRowClick,
  onMarkOverflow,
}: ListRowContentProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const placeholderBackground = isDarkMode
    ? alpha(theme.palette.common.black, 0.18)
    : alpha(theme.palette.common.black, 0.03);
  const firebaseRowBackground = isDarkMode ? alpha(theme.palette.common.white, 0.03) : theme.palette.background.paper;
  const firebaseRowHoverBackground = isDarkMode ? alpha(theme.palette.common.white, 0.06) : theme.palette.action.hover;
  const placeholderBorder = isDarkMode
    ? alpha(theme.palette.common.white, 0.09)
    : alpha(theme.palette.common.black, 0.08);
  const placeholderPrimaryText = alpha(theme.palette.text.primary, 0.4);
  const placeholderSecondaryText = isDarkMode
    ? alpha(theme.palette.text.secondary, 0.82)
    : alpha(theme.palette.text.secondary, 0.6);

  return (
    <Box
      onClick={onRowClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 1.25, sm: 1.5 },
        p: { xs: 1.25, sm: 1.5 },
        cursor: item.rowNavigationDisabled ? 'default' : 'pointer',
        bgcolor: item.isPlaceholder ? placeholderBackground : isDragging ? 'action.selected' : firebaseRowBackground,
        boxShadow: isDragging ? 4 : 0,
        borderLeft: `3px solid ${placeholderBorder}`,
        transition: 'background-color 0.15s ease',
        contentVisibility: isDragging ? 'visible' : 'auto',
        containIntrinsicSize: '72px',
        '&:hover': {
          bgcolor: item.rowNavigationDisabled
            ? item.isPlaceholder
              ? placeholderBackground
              : firebaseRowBackground
            : item.isPlaceholder
              ? placeholderBackground
              : isDragging
                ? 'action.selected'
                : firebaseRowHoverBackground,
        },
      }}
    >
      <Box
        {...dragHandleAttributes}
        {...dragHandleListeners}
        data-no-row-nav="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          cursor: isDragging ? 'grabbing' : 'grab',
          color: 'text.disabled',
          touchAction: 'none',
          '&:hover': { color: 'text.secondary' },
        }}
      >
        <DragIndicatorIcon />
      </Box>

      <Typography
        variant="body2"
        sx={{
          width: { xs: 24, sm: 32 },
          textAlign: 'center',
          color: 'text.secondary',
          fontWeight: 600,
          fontSize: '0.75rem',
        }}
      >
        {index + 1}
      </Typography>

      <AvatarWithDefaultImage
        image={item.preferredImage}
        altName={item.title || 'Sermon'}
        width={44}
        height={44}
        borderRadius={6}
        sx={{ flexShrink: 0 }}
      />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: item.isPlaceholder ? placeholderPrimaryText : 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
          {item.dateString ? (
            <Typography variant="caption" color={item.isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {item.dateString}
            </Typography>
          ) : null}
          {item.speakerSummary ? (
            <Typography variant="caption" color={item.isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {item.speakerSummary}
            </Typography>
          ) : null}
          {item.rowTypeLabel ? (
            <Typography variant="caption" color={item.isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {item.rowTypeLabel}
            </Typography>
          ) : null}
        </Box>
      </Box>

      <Chip
        icon={item.isSyncedToList ? <CheckCircleIcon /> : <PendingIcon />}
        label={item.statusLabel}
        color={item.statusColor}
        size="small"
        variant={item.statusVariant}
        sx={
          item.isPlaceholder
            ? {
                flexShrink: 0,
                color: isDarkMode
                  ? alpha(theme.palette.warning.light, 0.95)
                  : theme.palette.warning.dark,
                borderColor: alpha(theme.palette.warning.main, isDarkMode ? 0.3 : 0.2),
                bgcolor: alpha(theme.palette.warning.main, isDarkMode ? 0.14 : 0.12),
              }
            : { flexShrink: 0 }
        }
      />
      {showPhysicalPlacement && item.physicalListTagLabel ? (
        <Chip
          label={item.physicalListTagLabel}
          size="small"
          color={placementDirty ? 'default' : 'info'}
          variant={placementDirty ? 'outlined' : 'filled'}
          sx={{ flexShrink: 0 }}
        />
      ) : null}
      {item.isOverflowCandidate && item.rowId ? (
        <Button
          size="small"
          variant="outlined"
          data-no-row-nav="true"
          onClick={() => onMarkOverflow?.(item.rowId!)}
          disabled={overflowMarkDisabled || overflowMarkLoading}
          sx={{ flexShrink: 0, textTransform: 'none' }}
        >
          {overflowMarkLoading ? <CircularProgress size={14} /> : `Mark as overflow list ${item.sourceDepth + 1}`}
        </Button>
      ) : null}
    </Box>
  );
});

const SortableListRow = memo(function SortableListRow({
  item,
  index,
  dragDisabled = false,
  overflowMarkDisabled = false,
  overflowMarkLoading = false,
  placementDirty = false,
  showPhysicalPlacement = false,
  onOpenSermon,
  onMarkOverflow,
  showDivider = false,
}: SortableListRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: dragDisabled,
  });

  const handleRowClick = useCallback(() => {
    if (item.rowNavigationDisabled) {
      return;
    }
    onOpenSermon(item.id);
  }, [item.id, item.rowNavigationDisabled, onOpenSermon]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const,
  };

  return (
    <Box ref={setNodeRef} style={style}>
      <ListRowContent
        item={item}
        index={index}
        overflowMarkDisabled={overflowMarkDisabled}
        overflowMarkLoading={overflowMarkLoading}
        placementDirty={placementDirty}
        showPhysicalPlacement={showPhysicalPlacement}
        isDragging={isDragging}
        dragHandleAttributes={attributes}
        dragHandleListeners={listeners}
        onRowClick={handleRowClick}
        onMarkOverflow={onMarkOverflow}
      />
      {showDivider ? <Divider /> : null}
    </Box>
  );
});

export default SortableListRow;
