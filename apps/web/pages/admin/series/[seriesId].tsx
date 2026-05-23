/**
 * Series Details Page
 * - View and edit series metadata
 * - Manage items in the series (add, remove, reorder)
 * - Show publish status for each item
 */
import { useRouter } from 'next/router';
import Head from 'next/head';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Stack from '@mui/material/Stack';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import SearchIcon from '@mui/icons-material/Search';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CollectionsIcon from '@mui/icons-material/Collections';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import Link from 'next/link';
import Image from 'next/image';
import { alpha, useTheme } from '@mui/material/styles';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import type { Modifier } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import AppLayout from '../../../layout/AppLayout';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import DetailImageGallery from '../../../components/DetailImageGallery';
import NewSeriesPopup from '../../../components/NewSeriesPopup';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import firestore, { doc, getDoc, collection, getDocs, query, orderBy, where, limit, deleteDoc, setDoc, updateDoc, writeBatch } from '../../../firebase/firestore';
import storage, { getDownloadURL, ref } from '../../../firebase/storage';
import { isDevelopment } from '../../../firebase/firebase';
import { Series, seriesConverter } from '../../../types/Series';
import { SeriesItem } from '../../../types/SeriesItem';
import { Sermon, uploadStatus } from '../../../types/SermonTypes';
import useAuth from '../../../context/user/UserContext';
import { createFunctionV2 } from '../../../utils/createFunction';
import {
  createOperationKey,
  createPublishedMembershipHash,
  createRetryIntentKey,
  parseLockBusyDetails,
} from '../../../utils/callableConcurrency';
import { canPublishSermonToSeries, SERIES_PUBLISH_BLOCKED_MESSAGE } from '../../../utils/seriesPublishUtils';
import { canEditSermonMetadata } from '../../../utils/sermonEditing';
import { reportHandledError, reportHandledMessage } from '../../../utils/reportHandledError';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '@upperroom/contracts/uploadToSubsplash';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '@upperroom/contracts/reorderSeriesItems';
import { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '@upperroom/contracts/removeFromSeries';
import { CreateSeriesInputType, CreateSeriesOutputType } from '@upperroom/contracts/createSeries';
import { DeleteSeriesInputType, DeleteSeriesOutputType } from '@upperroom/contracts/deleteSeries';
import type { BulkAddToSeriesInputType, BulkAddToSeriesOutputType } from '@upperroom/contracts/bulkAddToSeries';
import type {
  GetSeriesRemoteStateOutputType,
  GetSeriesRemoteStateRemoteItem,
} from '../../../../../packages/contracts/getSeriesRemoteState';
import { serverTimestamp, deleteField } from 'firebase/firestore';
import { getSeriesItemPublishChipState } from '../../../utils/seriesItemPublishChipState';

interface SeriesItemWithSermon extends SeriesItem {
  sermon?: Sermon;
}

interface SeriesDisplayItem extends SeriesItemWithSermon {
  displayId: string;
  sermonId?: string;
  remoteMediaItemId?: string;
  remoteStatus?: GetSeriesRemoteStateRemoteItem['remoteStatus'];
  remoteTitle?: string;
  remoteSubtitle?: string;
  remoteImageUrl?: string;
  remoteImageType?: string;
  isSubsplashOnlyPlaceholder: boolean;
  isTrackedInFirebase: boolean;
  canReorder: boolean;
  canUnpublish: boolean;
  canRemoveLocally: boolean;
}

type InlineNotice = {
  severity: 'success' | 'info' | 'warning' | 'error';
  message: string;
} | null;

type SeriesPublishAttemptResult =
  | { ok: true }
  | { ok: false; error?: unknown };

type PublishedOrderToken =
  | { type: 'addition'; sermonId: string; mediaItemId: string | undefined }
  | { type: 'remote'; mediaItemId: string };

const cloneSeriesDisplayItems = (source: SeriesDisplayItem[]): SeriesDisplayItem[] =>
  source.map((item) => ({
    ...item,
    sermon: item.sermon ? { ...item.sermon } : undefined,
  }));

const createLocalDisplayItem = (item: SeriesItemWithSermon): SeriesDisplayItem => ({
  ...item,
  displayId: item.id,
  sermonId: item.id,
  remoteMediaItemId: item.sermonSubsplashId || item.sermon?.subsplashId,
  remoteTitle: item.sermon?.title,
  remoteSubtitle: item.sermon?.dateString,
  isSubsplashOnlyPlaceholder: false,
  isTrackedInFirebase: true,
  canReorder: true,
  canUnpublish: item.publishedToSubsplash === true,
  canRemoveLocally: true,
});

const createPlaceholderDisplayItem = (remoteItem: GetSeriesRemoteStateRemoteItem): SeriesDisplayItem => ({
  id: `remote:${remoteItem.mediaItemId}`,
  displayId: `remote:${remoteItem.mediaItemId}`,
  sermonId: undefined,
  position: 0,
  addedAt: null,
  publishedToSubsplash: remoteItem.remoteStatus === 'published',
  sermonSubsplashId: remoteItem.mediaItemId,
  remoteMediaItemId: remoteItem.mediaItemId,
  remoteStatus: remoteItem.remoteStatus,
  remoteTitle: remoteItem.title,
  remoteSubtitle: remoteItem.subtitle,
  remoteImageUrl: remoteItem.imageUrl,
  remoteImageType: remoteItem.imageType,
  isSubsplashOnlyPlaceholder: true,
  isTrackedInFirebase: false,
  canReorder: remoteItem.canReorder,
  canUnpublish: remoteItem.canUnpublish,
  canRemoveLocally: false,
});

const buildSeriesDisplayItems = (
  localItems: SeriesItemWithSermon[],
  remoteState: GetSeriesRemoteStateOutputType | null
): SeriesDisplayItem[] => {
  const localDisplayItems = localItems.map(createLocalDisplayItem);
  if (!remoteState) {
    return localDisplayItems;
  }

  const localBySermonId = new Map(localDisplayItems.map((item) => [item.sermonId || item.id, item]));
  const matchedTrackedIds = new Set(
    remoteState.remoteItems
      .map((item) => item.matchedSermonId)
      .filter((itemId): itemId is string => Boolean(itemId))
  );

  const remoteDisplayItems = remoteState.remoteItems.map((remoteItem) => {
    if (remoteItem.matchedSermonId) {
      const localItem = localBySermonId.get(remoteItem.matchedSermonId);
      if (localItem) {
        return {
          ...localItem,
          remoteMediaItemId: remoteItem.mediaItemId,
          sermonSubsplashId: remoteItem.mediaItemId,
          publishedToSubsplash: remoteItem.publishedToSubsplashInFirebase,
          remoteStatus: remoteItem.remoteStatus,
          remoteTitle: remoteItem.title || localItem.sermon?.title,
          remoteSubtitle: remoteItem.subtitle || localItem.sermon?.dateString,
          remoteImageUrl: remoteItem.imageUrl,
          remoteImageType: remoteItem.imageType,
          isSubsplashOnlyPlaceholder: false,
          isTrackedInFirebase: true,
          canReorder: remoteItem.canReorder,
          canUnpublish: remoteItem.canUnpublish,
          canRemoveLocally: true,
        } satisfies SeriesDisplayItem;
      }
    }

    return createPlaceholderDisplayItem(remoteItem);
  });

  const localOnlyItemsByAnchor = new Map<number, SeriesDisplayItem[]>();
  let matchedTrackedSeen = 0;
  localDisplayItems.forEach((item) => {
    if (item.sermonId && matchedTrackedIds.has(item.sermonId)) {
      matchedTrackedSeen += 1;
      return;
    }

    const existing = localOnlyItemsByAnchor.get(matchedTrackedSeen) || [];
    existing.push(item);
    localOnlyItemsByAnchor.set(matchedTrackedSeen, existing);
  });

  const combinedItems: SeriesDisplayItem[] = [];
  const prependItems = localOnlyItemsByAnchor.get(0);
  if (prependItems) {
    combinedItems.push(...prependItems);
  }

  let remoteTrackedSeen = 0;
  remoteDisplayItems.forEach((item) => {
    combinedItems.push(item);
    if (item.sermonId && matchedTrackedIds.has(item.sermonId)) {
      remoteTrackedSeen += 1;
      const anchoredItems = localOnlyItemsByAnchor.get(remoteTrackedSeen);
      if (anchoredItems) {
        combinedItems.push(...anchoredItems);
      }
    }
  });

  for (const [anchor, anchoredItems] of localOnlyItemsByAnchor.entries()) {
    if (anchor > remoteTrackedSeen) {
      combinedItems.push(...anchoredItems);
    }
  }

  return combinedItems.map((item, index, source) => ({
    ...item,
    position: source.length - index,
  }));
};

const getLockBusyMessage = (error: unknown, fallbackMessage: string): string => {
  const busyDetails = parseLockBusyDetails(error);
  if (!busyDetails) {
    return fallbackMessage;
  }

  const retryInSeconds = Math.max(1, Math.ceil(busyDetails.retry_after_ms / 1000));
  const lockedKeys = busyDetails.locked_keys.length > 0 ? ` Locked keys: ${busyDetails.locked_keys.join(', ')}.` : '';
  return `${fallbackMessage} Another publishing action is in progress.${lockedKeys} Retry in about ${retryInSeconds}s.`;
};

const getErrorField = (error: unknown, field: 'code' | 'message'): string | undefined => {
  if (field === 'message' && error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
};

const getErrorMessage = (error: unknown, fallbackMessage: string): string =>
  getErrorField(error, 'message') || fallbackMessage;

const SERIES_REMOTE_MEMBERSHIP_CHANGED_MESSAGE =
  'Series membership changed in Subsplash. Refresh the series and retry.';

const isExpectedSeriesManagementError = (error: unknown): boolean => {
  if (parseLockBusyDetails(error)) {
    return true;
  }

  const message = getErrorMessage(error, '');
  return (
    message.includes('cannot be added while audio is queued or processing') ||
    message.includes('cannot be added to a series while audio is queued or processing') ||
    message.includes('You do not have permission to add') ||
    message.includes('You do not have permission to update this series') ||
    message === 'Published membership changed in Subsplash. Refresh the series and retry with a fresh snapshot hash.' ||
    message === SERIES_REMOTE_MEMBERSHIP_CHANGED_MESSAGE
  );
};

interface SortableItemProps {
  item: SeriesDisplayItem;
  index: number;
  isSelected: boolean;
  onToggleSelected: (displayId: string, checked: boolean) => void;
  onOpenSermon: (id: string) => void;
  onRequestPublish: (item: SeriesDisplayItem) => void;
  onRequestUnpublish: (item: SeriesDisplayItem) => void;
  isPublishing: boolean;
  isUnpublishing: boolean;
  actionsDisabled: boolean;
  canPublish: boolean;
  publishBlockedReason?: string;
}

const SortableItem = memo(({
  item,
  index,
  isSelected,
  onToggleSelected,
  onOpenSermon,
  onRequestPublish,
  onRequestUnpublish,
  isPublishing,
  isUnpublishing,
  actionsDisabled,
  canPublish,
  publishBlockedReason,
}: SortableItemProps) => {
  const theme = useTheme();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.displayId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const,
  };

  const isDarkMode = theme.palette.mode === 'dark';
  const isPlaceholder = item.isSubsplashOnlyPlaceholder;
  const placeholderBackground = isDarkMode
    ? alpha(theme.palette.common.black, 0.18)
    : alpha(theme.palette.common.black, 0.03);
  const firebaseRowBackground = isDarkMode ? alpha(theme.palette.common.white, 0.03) : 'background.paper';
  const firebaseRowHoverBackground = isDarkMode ? alpha(theme.palette.common.white, 0.06) : 'action.hover';
  const placeholderBorder = isDarkMode
    ? alpha(theme.palette.common.white, 0.09)
    : alpha(theme.palette.common.black, 0.08);
  const placeholderPrimaryText = alpha(theme.palette.text.primary, isDarkMode ? 0.58 : 0.4);
  const placeholderSecondaryText = isDarkMode
    ? alpha(theme.palette.text.secondary, 0.82)
    : alpha(theme.palette.text.secondary, 0.6);
  const publishChipState = getSeriesItemPublishChipState({
    publishedToSubsplash: item.publishedToSubsplash,
    isPublishing,
    isUnpublishing,
  });

  const localImage = item.sermon?.images?.find((img) => img.type === 'square')
    || item.sermon?.images?.find((img) => img.type === 'wide')
    || item.sermon?.images?.[0];

  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button,a,[role="button"],[data-no-row-nav="true"]')) {
      return;
    }
    if (item.sermonId) {
      onOpenSermon(item.sermonId);
    }
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      onClick={handleRowClick}
      sx={{
        display: 'flex',
        alignItems: { xs: 'flex-start', sm: 'center' },
        flexWrap: { xs: 'wrap', sm: 'nowrap' },
        columnGap: { xs: 1, sm: 1.5 },
        rowGap: { xs: 0.75, sm: 1.5 },
        p: { xs: 1.25, sm: 1.5 },
        cursor: isPlaceholder ? 'default' : item.sermonId ? 'pointer' : 'default',
        bgcolor: isPlaceholder ? placeholderBackground : isDragging ? 'action.selected' : firebaseRowBackground,
        boxShadow: isDragging ? 4 : 0,
        borderLeft: `3px solid ${placeholderBorder}`,
        transition: 'background-color 0.15s ease',
        '&:hover': {
          bgcolor: isPlaceholder
            ? placeholderBackground
            : isDragging
              ? 'action.selected'
              : (item.sermonId ? firebaseRowHoverBackground : firebaseRowBackground),
        },
      }}
    >
      <Box
        sx={{
          display: { xs: 'flex', sm: 'none' },
          flexDirection: 'column',
          gap: 0.75,
          width: '100%',
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: 0,
          }}
        >
          <Box
            {...attributes}
            {...listeners}
            data-no-row-nav="true"
            sx={{
              display: 'flex',
              alignItems: 'center',
              cursor: isDragging ? 'grabbing' : 'grab',
              color: 'text.disabled',
              touchAction: 'none',
              flexShrink: 0,
              '&:hover': { color: 'text.secondary' },
            }}
          >
            <DragIndicatorIcon />
          </Box>

          <Typography
            variant="body2"
            sx={{
              width: 20,
              textAlign: 'center',
              color: 'text.tertiary',
              fontWeight: 600,
              fontSize: '0.68rem',
              flexShrink: 0,
            }}
          >
            {index + 1}
          </Typography>

          {localImage ? (
            <AvatarWithDefaultImage
              image={localImage}
              altName={item.sermon?.title || item.remoteTitle || 'Sermon'}
              width={40}
              height={40}
              borderRadius={6}
              sx={{ flexShrink: 0 }}
            />
          ) : item.remoteImageUrl ? (
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: '6px',
                flexShrink: 0,
                overflow: 'hidden',
                position: 'relative',
                bgcolor: 'action.hover',
              }}
            >
              <Image
                src={item.remoteImageUrl}
                alt={item.remoteTitle || 'Subsplash item'}
                fill
                sizes="40px"
                style={{ objectFit: 'cover' }}
              />
            </Box>
          ) : (
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 1.5,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'action.hover',
                color: 'text.secondary',
              }}
            >
              <CollectionsIcon fontSize="small" />
            </Box>
          )}

          <Box sx={{ flex: 1 }} />

          {item.publishedToSubsplash || item.isSubsplashOnlyPlaceholder ? (
            <Button
              size="small"
              color="warning"
              variant="outlined"
              startIcon={isUnpublishing ? <CircularProgress size={14} /> : <CloudOffIcon fontSize="small" />}
              onClick={(event) => {
                event.stopPropagation();
                onRequestUnpublish(item);
              }}
              disabled={actionsDisabled || isUnpublishing}
              sx={{
                whiteSpace: 'nowrap',
                minWidth: 0,
                fontSize: '0.7rem',
                px: 1,
                flexShrink: 0,
              }}
            >
              {item.isSubsplashOnlyPlaceholder ? 'Remove Remote' : 'Unpublish'}
            </Button>
          ) : (
            <Button
              size="small"
              color="primary"
              variant="contained"
              startIcon={isPublishing ? <CircularProgress size={14} color="inherit" /> : <CloudUploadIcon fontSize="small" />}
              onClick={(event) => {
                event.stopPropagation();
                onRequestPublish(item);
              }}
              disabled={actionsDisabled || isPublishing || !canPublish || item.isSubsplashOnlyPlaceholder}
              title={!canPublish ? (publishBlockedReason || SERIES_PUBLISH_BLOCKED_MESSAGE) : undefined}
              sx={{
                whiteSpace: 'nowrap',
                minWidth: 0,
                fontSize: '0.7rem',
                px: 1,
                flexShrink: 0,
              }}
            >
              Publish
            </Button>
          )}

          {(item.canRemoveLocally || item.isSubsplashOnlyPlaceholder) ? (
            <Checkbox
              checked={isSelected}
              size="small"
              data-no-row-nav="true"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onChange={(event) => {
                event.stopPropagation();
                onToggleSelected(item.displayId, event.target.checked);
              }}
              sx={{ p: 0.25, ml: 0.25, flexShrink: 0 }}
            />
          ) : (
            <Box sx={{ width: 26, flexShrink: 0 }} />
          )}
        </Box>

        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: isPlaceholder ? placeholderPrimaryText : 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '0.82rem',
            minWidth: 0,
          }}
        >
          {item.sermon?.title || item.remoteTitle || `Sermon ${item.displayId}`}
        </Typography>

        <Box
          sx={{
            display: 'flex',
            gap: 0.5,
            alignItems: 'center',
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          {(item.sermon?.dateString || item.remoteSubtitle) && (
            <Typography
              variant="caption"
              color={isPlaceholder ? placeholderSecondaryText : 'text.secondary'}
              sx={{ fontSize: '0.68rem' }}
            >
              {item.sermon?.dateString || item.remoteSubtitle}
            </Typography>
          )}
          {item.isSubsplashOnlyPlaceholder && (
            <Chip
              label="Subsplash only"
              size="small"
              color="warning"
              variant="filled"
              sx={{
                height: 20,
                '& .MuiChip-label': {
                  px: 0.75,
                  fontSize: '0.62rem',
                },
                color: isDarkMode ? alpha(theme.palette.warning.light, 0.95) : theme.palette.warning.dark,
                borderColor: alpha(theme.palette.warning.main, isDarkMode ? 0.3 : 0.2),
                bgcolor: alpha(theme.palette.warning.main, isDarkMode ? 0.14 : 0.12),
              }}
            />
          )}
          <Chip
            icon={
              publishChipState.isBusy
                ? <CircularProgress size={13} color="inherit" />
                : publishChipState.color === 'success'
                  ? <CheckCircleIcon />
                  : <PendingIcon />
            }
            label={publishChipState.label}
            size="small"
            color={publishChipState.color}
            variant={publishChipState.variant}
            title={publishChipState.tooltip}
            sx={{
              height: 20,
              '& .MuiChip-label': {
                px: 0.75,
                fontSize: '0.62rem',
              },
              '& .MuiChip-icon': {
                fontSize: '0.85rem',
              },
            }}
          />
        </Box>
      </Box>

      <Box
        sx={{
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          width: '100%',
          minWidth: 0,
          gap: 1.5,
        }}
      >
        {/* Drag Handle */}
        <Box
          {...attributes}
          {...listeners}
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
            width: 32,
            textAlign: 'center',
            color: 'text.tertiary',
            fontWeight: 600,
            fontSize: '0.75rem',
          }}
        >
          {index + 1}
        </Typography>

        {localImage ? (
          <AvatarWithDefaultImage
            image={localImage}
            altName={item.sermon?.title || item.remoteTitle || 'Sermon'}
            width={44}
            height={44}
            borderRadius={6}
            sx={{ flexShrink: 0 }}
          />
        ) : item.remoteImageUrl ? (
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: '6px',
              flexShrink: 0,
              overflow: 'hidden',
              position: 'relative',
              bgcolor: 'action.hover',
            }}
          >
            <Image
              src={item.remoteImageUrl}
              alt={item.remoteTitle || 'Subsplash item'}
              fill
              sizes="44px"
              style={{ objectFit: 'cover' }}
            />
          </Box>
        ) : (
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 1.5,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'action.hover',
              color: 'text.secondary',
            }}
          >
            <CollectionsIcon fontSize="small" />
          </Box>
        )}

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              color: isPlaceholder ? placeholderPrimaryText : 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '0.875rem',
            }}
          >
            {item.sermon?.title || item.remoteTitle || `Sermon ${item.displayId}`}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              alignItems: 'center',
              flexWrap: 'wrap',
              mt: 0.5,
            }}
          >
            {(item.sermon?.dateString || item.remoteSubtitle) && (
              <Typography
                variant="caption"
                color={isPlaceholder ? placeholderSecondaryText : 'text.secondary'}
                sx={{ fontSize: '0.75rem' }}
              >
                {item.sermon?.dateString || item.remoteSubtitle}
              </Typography>
            )}
            {item.isSubsplashOnlyPlaceholder && (
              <Chip
                label="Subsplash only"
                size="small"
                color="warning"
                variant="filled"
                sx={{
                  height: 22,
                  '& .MuiChip-label': {
                    px: 1,
                    fontSize: '0.7rem',
                  },
                  color: isDarkMode ? alpha(theme.palette.warning.light, 0.95) : theme.palette.warning.dark,
                  borderColor: alpha(theme.palette.warning.main, isDarkMode ? 0.3 : 0.2),
                  bgcolor: alpha(theme.palette.warning.main, isDarkMode ? 0.14 : 0.12),
                }}
              />
            )}
            <Chip
              icon={
                publishChipState.isBusy
                  ? <CircularProgress size={13} color="inherit" />
                  : publishChipState.color === 'success'
                    ? <CheckCircleIcon />
                    : <PendingIcon />
              }
              label={publishChipState.label}
              size="small"
              color={publishChipState.color}
              variant={publishChipState.variant}
              title={publishChipState.tooltip}
              sx={{
                height: 22,
                '& .MuiChip-label': {
                  px: 1,
                  fontSize: '0.7rem',
                },
              }}
            />
          </Box>
        </Box>

        {item.publishedToSubsplash || item.isSubsplashOnlyPlaceholder ? (
          <Button
            size="small"
            color="warning"
            variant="outlined"
            startIcon={isUnpublishing ? <CircularProgress size={14} /> : <CloudOffIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              onRequestUnpublish(item);
            }}
            disabled={actionsDisabled || isUnpublishing}
            sx={{
              whiteSpace: 'nowrap',
              minWidth: 64,
              fontSize: '0.8125rem',
              px: 1.25,
            }}
          >
            {item.isSubsplashOnlyPlaceholder ? 'Remove Remote' : 'Unpublish'}
          </Button>
        ) : (
          <Button
            size="small"
            color="primary"
            variant="contained"
            startIcon={isPublishing ? <CircularProgress size={14} color="inherit" /> : <CloudUploadIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              onRequestPublish(item);
            }}
            disabled={actionsDisabled || isPublishing || !canPublish || item.isSubsplashOnlyPlaceholder}
            title={!canPublish ? (publishBlockedReason || SERIES_PUBLISH_BLOCKED_MESSAGE) : undefined}
            sx={{
              whiteSpace: 'nowrap',
              minWidth: 64,
              fontSize: '0.8125rem',
              px: 1.25,
            }}
          >
            Publish
          </Button>
        )}

        {(item.canRemoveLocally || item.isSubsplashOnlyPlaceholder) ? (
          <Checkbox
            checked={isSelected}
            size="small"
            data-no-row-nav="true"
            onClick={(event) => {
              event.stopPropagation();
            }}
            onChange={(event) => {
              event.stopPropagation();
              onToggleSelected(item.displayId, event.target.checked);
            }}
            sx={{ p: 0.5, ml: 0.25, flexShrink: 0 }}
          />
        ) : (
          <Box sx={{ width: 30, flexShrink: 0 }} />
        )}
      </Box>
    </Box>
  );
});

SortableItem.displayName = 'SortableItem';

const SeriesDetailsPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const seriesId = router.query.seriesId as string;

  const [series, setSeries] = useState<Series | null>(null);
  const [items, setItems] = useState<SeriesDisplayItem[]>([]);
  const [remoteSeriesState, setRemoteSeriesState] = useState<GetSeriesRemoteStateOutputType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editPopup, setEditPopup] = useState(false);
  const [deletePopup, setDeletePopup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [addItemPopup, setAddItemPopup] = useState(false);

  // Store original item order for revert functionality
  const originalItemsRef = useRef<SeriesDisplayItem[]>([]);

  // Ref for the sortable container to restrict drag bounds
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableSermons, setAvailableSermons] = useState<Sermon[]>([]);
  const [loadingSermons, setLoadingSermons] = useState(false);
  const [sermonSearchQuery, setSermonSearchQuery] = useState('');
  const [selectedSermonIds, setSelectedSermonIds] = useState<Set<string>>(new Set());
  const [isAddingSelectedSermons, setIsAddingSelectedSermons] = useState(false);
  const [activeAddingSermonId, setActiveAddingSermonId] = useState<string | null>(null);
  const [publishingItemId, setPublishingItemId] = useState<string | null>(null);
  const [unpublishingItemId, setUnpublishingItemId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SeriesDisplayItem | null>(null);
  const [unpublishTarget, setUnpublishTarget] = useState<SeriesDisplayItem | null>(null);
  const [isRemovingItem, setIsRemovingItem] = useState(false);
  const [selectedSeriesItemIds, setSelectedSeriesItemIds] = useState<Set<string>>(new Set());
  const [pageNotice, setPageNotice] = useState<InlineNotice>(null);
  const [addItemNotice, setAddItemNotice] = useState<InlineNotice>(null);

  const isAdmin = user?.isAdmin() ?? false;

  const fetchRemoteSeriesState = useCallback(async (): Promise<GetSeriesRemoteStateOutputType> => {
    if (!seriesId) {
      throw new Error('Series id is required to fetch remote state.');
    }

    const getSeriesRemoteStateFunction = createFunctionV2<{ firestoreSeriesId: string }, GetSeriesRemoteStateOutputType>(
      'getseriesremotestate'
    );
    return getSeriesRemoteStateFunction({
      firestoreSeriesId: seriesId,
    });
  }, [seriesId]);

  // Fetch series and items
  const fetchSeriesData = useCallback(async () => {
    if (!seriesId) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch series
      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter));
      if (!seriesDoc.exists()) {
        setError('Series not found');
        setLoading(false);
        return;
      }

      const seriesData = seriesDoc.data();

      // Check ownership (non-admins can only view their own series)
      if (!isAdmin && seriesData.ownerId !== user?.uid) {
        setError('You do not have permission to view this series');
        setLoading(false);
        return;
      }

      // Fetch series items
      const itemsQuery = query(
        collection(firestore, `series/${seriesId}/seriesItems`),
        // Subsplash semantics: position 1 is the bottom item, so show highest position first.
        orderBy('position', 'desc')
      );

      const itemsSnapshot = await getDocs(itemsQuery);
      const itemsData = itemsSnapshot.docs.map((itemDoc) => {
        const rawItem = itemDoc.data() as Partial<SeriesItem> & { sermonSubsplashId?: string | null };

        return {
          id: itemDoc.id,
          position: typeof rawItem.position === 'number' ? rawItem.position : 0,
          addedAt: rawItem.addedAt ?? null,
          sermonSubsplashId: rawItem.sermonSubsplashId ?? undefined,
          publishedToSubsplash: rawItem.publishedToSubsplash === true,
        } as SeriesItem;
      });

      // Fetch sermon data for each item
      const itemsWithSermons: SeriesItemWithSermon[] = await Promise.all(
        itemsData.map(async (item) => {
          try {
            const sermonDoc = await getDoc(doc(firestore, 'sermons', item.id));
            if (sermonDoc.exists()) {
              return { ...item, sermon: sermonDoc.data() as Sermon };
            }
          } catch (err) {
            console.error(`Error fetching sermon ${item.id}:`, err);
          }
          return item;
        })
      );

      let nextRemoteSeriesState: GetSeriesRemoteStateOutputType | null = null;
      if (seriesData.subsplashId) {
        try {
          nextRemoteSeriesState = await fetchRemoteSeriesState();
        } catch (remoteError) {
          console.error('Error fetching remote series state:', remoteError);
        }
      }

      setSeries(seriesData);
      setRemoteSeriesState(nextRemoteSeriesState);

      const mergedItems = buildSeriesDisplayItems(itemsWithSermons, nextRemoteSeriesState);
      setItems(mergedItems);
      setSelectedSeriesItemIds((previousSelected) => {
        const validIds = new Set(mergedItems.map((item) => item.displayId));
        return new Set(Array.from(previousSelected).filter((itemId) => validIds.has(itemId)));
      });
      // Store original order for revert functionality
      originalItemsRef.current = cloneSeriesDisplayItems(mergedItems);
    } catch (err: unknown) {
      console.error('Error fetching series:', err);
      setError(getErrorMessage(err, 'Failed to fetch series'));
    }

    setLoading(false);
  }, [fetchRemoteSeriesState, seriesId, user?.uid, isAdmin]);

  useEffect(() => {
    fetchSeriesData();
  }, [fetchSeriesData]);

  // Fetch available sermons for adding to series
  const fetchAvailableSermons = useCallback(async () => {
    if (!user) return;

    setLoadingSermons(true);
    try {
      // Admins can see all sermons, non-admins only see their own
      const sermonsQuery = isAdmin
        ? query(
          collection(firestore, 'sermons'),
          orderBy('createdAtMillis', 'desc'),
          limit(100)
        )
        : query(
          collection(firestore, 'sermons'),
          where('uploaderId', '==', user.uid),
          orderBy('createdAtMillis', 'desc'),
          limit(50)
        );

      const sermonsSnapshot = await getDocs(sermonsQuery);
      const sermons = sermonsSnapshot.docs
        .map((doc) => ({ ...doc.data(), id: doc.id } as Sermon))
        .filter((sermon) => !sermon.seriesId || sermon.seriesId === seriesId); // Show sermons not in any series, or already in this series

      setAvailableSermons(sermons);
    } catch (err) {
      console.error('Error fetching sermons:', err);
    }
    setLoadingSermons(false);
  }, [user, seriesId, isAdmin]);

  const closeAddItemDialog = useCallback(() => {
    if (isAddingSelectedSermons) {
      return;
    }
    setSermonSearchQuery('');
    setSelectedSermonIds(new Set());
    setAddItemNotice(null);
    setAddItemPopup(false);
  }, [isAddingSelectedSermons]);

  const isSermonPublishedToSubsplash = useCallback((sermon: Sermon | undefined): boolean => {
    if (!sermon) {
      return false;
    }

    return Boolean(
      sermon.subsplashId ||
      sermon.status?.subsplash === uploadStatus.UPLOADED
    );
  }, []);

  const getRemoteDisplayItems = useCallback(
    (sourceItems: SeriesDisplayItem[]) => sourceItems.filter((item) => Boolean(item.remoteMediaItemId)),
    []
  );

  const createFreshRemoteMembershipHash = useCallback(
    (remoteState: GetSeriesRemoteStateOutputType): string =>
      remoteState.mediaItemMembershipHash
      || createPublishedMembershipHash(remoteState.remoteItems.map((item) => item.mediaItemId)),
    []
  );

  const getPublishedRemoteOrderWithAdditions = useCallback(
    (
      sourceItems: SeriesDisplayItem[],
      remoteState: GetSeriesRemoteStateOutputType,
      additions: Map<string, string>
    ) => {
      const freshPublishedOrder = remoteState.remoteItems
        .filter((item) => item.remoteStatus === 'published')
        .map((item) => item.mediaItemId);
      const remotePublishedMediaItemIds = new Set(freshPublishedOrder);
      const orderedMediaItemIds: string[] = [];
      const seenMediaItemIds = new Set<string>();
      const additionsByAnchor = new Map<string, string[]>();
      const trailingAdditions: string[] = [];
      const anchoredAdditionSermonIds = new Set<string>();

      const appendMediaItemId = (mediaItemId: string | undefined): void => {
        if (!mediaItemId || seenMediaItemIds.has(mediaItemId)) {
          return;
        }
        orderedMediaItemIds.push(mediaItemId);
        seenMediaItemIds.add(mediaItemId);
      };

      const sourceTokens = sourceItems
        .map((item): PublishedOrderToken | null => {
          if (item.sermonId && additions.has(item.sermonId)) {
            return { type: 'addition' as const, sermonId: item.sermonId, mediaItemId: additions.get(item.sermonId) };
          }
          if (item.remoteMediaItemId && remotePublishedMediaItemIds.has(item.remoteMediaItemId)) {
            return { type: 'remote' as const, mediaItemId: item.remoteMediaItemId };
          }
          return null;
        })
        .filter((token): token is PublishedOrderToken => token !== null);

      sourceTokens.forEach((token, index) => {
        if (token.type !== 'addition' || !token.mediaItemId) {
          return;
        }
        anchoredAdditionSermonIds.add(token.sermonId);
        const anchor = sourceTokens
          .slice(index + 1)
          .find((candidate) => candidate.type === 'remote' && remotePublishedMediaItemIds.has(candidate.mediaItemId));
        if (anchor?.type === 'remote') {
          const anchoredAdditions = additionsByAnchor.get(anchor.mediaItemId) || [];
          anchoredAdditions.push(token.mediaItemId);
          additionsByAnchor.set(anchor.mediaItemId, anchoredAdditions);
          return;
        }
        trailingAdditions.push(token.mediaItemId);
      });

      additions.forEach((mediaItemId, sermonId) => {
        if (!anchoredAdditionSermonIds.has(sermonId)) {
          trailingAdditions.push(mediaItemId);
        }
      });

      freshPublishedOrder.forEach((mediaItemId) => {
        additionsByAnchor.get(mediaItemId)?.forEach(appendMediaItemId);
        appendMediaItemId(mediaItemId);
      });
      trailingAdditions.forEach(appendMediaItemId);

      return orderedMediaItemIds;
    },
    []
  );

  const ensureSeriesSubsplashId = useCallback(async (): Promise<string> => {
    if (!series) {
      throw new Error('Series not found.');
    }

    if (series.subsplashId) {
      return series.subsplashId;
    }

    const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
    const createResult = await createSeriesFunction({
      title: series.name,
      summary: series.summary,
      ownerId: series.ownerId,
      firestoreId: series.id,
      skipSubsplash: false,
      images: series.images,
      operationKey: createOperationKey('series-admin-create-series', series.id),
    });

    if (createResult.status !== 'success' || !createResult.subsplashId) {
      throw new Error(createResult.error || 'Failed to create series in Subsplash.');
    }
    const createdSubsplashId = createResult.subsplashId;

    await updateDoc(doc(firestore, 'series', series.id), {
      subsplashId: createdSubsplashId,
      status: 'published',
    });

    setSeries((previousSeries) => (
      previousSeries
        ? { ...previousSeries, subsplashId: createdSubsplashId, status: 'published' }
        : previousSeries
    ));

    return createdSubsplashId;
  }, [series]);

  const uploadSermonToSubsplash = useCallback(async (sermon: Sermon): Promise<string> => {
    if (sermon.subsplashId) {
      return sermon.subsplashId;
    }

    const uploadToSubsplashFunction = createFunctionV2<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, unknown>('uploadToSubsplash');
    const audioUrl = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.id}`));
    const uploadPayload: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
      title: sermon.title,
      subtitle: sermon.subtitle,
      speakers: sermon.speakers,
      autoPublish: !isDevelopment,
      audioTitle: sermon.title,
      audioUrl,
      topics: sermon.topics,
      description: sermon.description,
      images: sermon.images,
      date: new Date(sermon.dateMillis),
      operationKey: createOperationKey('series-admin-upload', sermon.id),
      lockKey: sermon.id,
    };

    const uploadResult = await uploadToSubsplashFunction(uploadPayload);
    if (!uploadResult || typeof uploadResult === 'string' || typeof uploadResult !== 'object') {
      throw new Error(typeof uploadResult === 'string' ? uploadResult : 'Failed to upload sermon to Subsplash.');
    }

    const uploadResultData = uploadResult as { id?: string };
    if (!uploadResultData.id) {
      throw new Error('Subsplash upload did not return a media item ID.');
    }

    const mediaItemId = uploadResultData.id;
    await updateDoc(doc(firestore, 'sermons', sermon.id), {
      subsplashId: mediaItemId,
      approverId: user?.uid ?? null,
    });

    setItems((previousItems) => previousItems.map((item) => (
      item.id === sermon.id && item.sermon
        ? {
          ...item,
          sermonSubsplashId: mediaItemId,
          sermon: {
            ...item.sermon,
            subsplashId: mediaItemId,
            status: { ...item.sermon.status, subsplash: uploadStatus.UPLOADED },
          },
        }
        : item
    )));

    return mediaItemId;
  }, [user?.uid]);

  const syncSeriesItemPublishedState = useCallback(async (
    seriesItemId: string,
    options: { publishedToSubsplash: boolean; sermonSubsplashId?: string }
  ) => {
    await setDoc(
      doc(firestore, `series/${seriesId}/seriesItems`, seriesItemId),
      {
        publishedToSubsplash: options.publishedToSubsplash,
        sermonSubsplashId: options.publishedToSubsplash
          ? options.sermonSubsplashId
          : deleteField(),
      },
      { merge: true }
    );

    setItems((previousItems) => previousItems.map((item) => (
      item.sermonId === seriesItemId
        ? {
          ...item,
          publishedToSubsplash: options.publishedToSubsplash,
          sermonSubsplashId: options.publishedToSubsplash ? options.sermonSubsplashId : undefined,
          remoteMediaItemId: options.publishedToSubsplash ? options.sermonSubsplashId : item.remoteMediaItemId,
          remoteStatus: options.publishedToSubsplash ? 'published' : item.remoteStatus,
        }
        : item
    )));
    originalItemsRef.current = originalItemsRef.current.map((item) => (
      item.sermonId === seriesItemId
        ? {
          ...item,
          publishedToSubsplash: options.publishedToSubsplash,
          sermonSubsplashId: options.publishedToSubsplash ? options.sermonSubsplashId : undefined,
          remoteMediaItemId: options.publishedToSubsplash ? options.sermonSubsplashId : item.remoteMediaItemId,
          remoteStatus: options.publishedToSubsplash ? 'published' : item.remoteStatus,
        }
        : item
    ));
  }, [seriesId]);

  const publishItemToSeries = useCallback(async (
    seriesItem: SeriesDisplayItem,
    options?: { suppressAlert?: boolean; orderSourceItems?: SeriesDisplayItem[] }
  ): Promise<SeriesPublishAttemptResult> => {
    if (!seriesItem.sermon || !seriesItem.sermonId) {
      if (!options?.suppressAlert) {
        setPageNotice({
          severity: 'error',
          message: 'Sermon details are missing for this item. Refresh and retry.',
        });
      }
      return { ok: false };
    }

    if (!canPublishSermonToSeries(seriesItem.sermon)) {
      if (!options?.suppressAlert) {
        setPageNotice({
          severity: 'warning',
          message: SERIES_PUBLISH_BLOCKED_MESSAGE,
        });
      }
      return { ok: false };
    }

    setPublishingItemId(seriesItem.id);
    try {
      const seriesSubsplashId = await ensureSeriesSubsplashId();
      const mediaItemId = await uploadSermonToSubsplash(seriesItem.sermon);
      const latestRemoteSeriesState = await fetchRemoteSeriesState();
      if (
        remoteSeriesState &&
        latestRemoteSeriesState.remoteMembershipHash !== remoteSeriesState.remoteMembershipHash
      ) {
        throw new Error(SERIES_REMOTE_MEMBERSHIP_CHANGED_MESSAGE);
      }
      const expectedPublishedMembershipHash = createFreshRemoteMembershipHash(latestRemoteSeriesState);
      const additions = new Map<string, string>([[seriesItem.sermonId, mediaItemId]]);
      const publishedItemOrder = getPublishedRemoteOrderWithAdditions(
        options?.orderSourceItems ?? items,
        latestRemoteSeriesState,
        additions
      );
      const intentFingerprint = [
        `${seriesItem.sermonId}:${mediaItemId}`,
        `order:${publishedItemOrder.join(',')}`,
        `snapshot:${expectedPublishedMembershipHash}`,
      ].join('|');
      const operationKey = createRetryIntentKey('series-admin-publish', seriesId, intentFingerprint);

      const bulkAddToSeriesFunction = createFunctionV2<BulkAddToSeriesInputType, BulkAddToSeriesOutputType>('bulkaddtoseries');
      const bulkResult = await bulkAddToSeriesFunction({
        firestoreSeriesId: seriesId,
        seriesSubsplashId,
        operationKey,
        expectedPublishedMembershipHash,
        adds: [{ sermonId: seriesItem.sermonId, mediaItemId }],
        publishedItemOrder,
        maxConcurrency: 1,
        rollbackOnFailure: true,
      });

      if (bulkResult.status !== 'success' || bulkResult.failed > 0 || !bulkResult.reorderApplied) {
        throw new Error(bulkResult.message || 'Failed to publish sermon to series in Subsplash.');
      }

      await syncSeriesItemPublishedState(seriesItem.sermonId, {
        publishedToSubsplash: true,
        sermonSubsplashId: mediaItemId,
      });
      await fetchSeriesData();
      if (!options?.suppressAlert) {
        setPageNotice({
          severity: 'success',
          message: `${seriesItem.sermon.title} was published to the series.`,
        });
      }

      return { ok: true };
    } catch (err: unknown) {
      if (isExpectedSeriesManagementError(err)) {
        console.warn('Series item publish was blocked:', err);
      } else {
        console.error('Error publishing series item:', err);
      }
      if (!options?.suppressAlert) {
        setPageNotice({
          severity: 'error',
          message: `Error publishing item to series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`,
        });
      }
      return { ok: false, error: err };
    } finally {
      setPublishingItemId(null);
    }
  }, [
    createFreshRemoteMembershipHash,
    ensureSeriesSubsplashId,
    fetchRemoteSeriesState,
    fetchSeriesData,
    getPublishedRemoteOrderWithAdditions,
    items,
    remoteSeriesState,
    seriesId,
    syncSeriesItemPublishedState,
    uploadSermonToSubsplash,
  ]);

  const unpublishItemFromSeries = useCallback(async (seriesItem: SeriesDisplayItem) => {
    setUnpublishingItemId(seriesItem.id);
    try {
      const mediaItemId = seriesItem.remoteMediaItemId || seriesItem.sermonSubsplashId || seriesItem.sermon?.subsplashId;
      if (mediaItemId) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        await removeFromSeriesFunction({
          mediaItemId,
          operationKey: createOperationKey('series-admin-unpublish-item', seriesItem.id),
        });
      }

      if (seriesItem.sermonId) {
        await updateDoc(doc(firestore, `series/${seriesId}/seriesItems`, seriesItem.sermonId), {
          publishedToSubsplash: false,
          sermonSubsplashId: deleteField(),
        });
      }

      await fetchSeriesData();
      setPageNotice({
        severity: 'info',
        message: `${seriesItem.sermon?.title || seriesItem.remoteTitle || 'The item'} was unpublished from the series.`,
      });
    } catch (err: unknown) {
      console.error('Error unpublishing series item:', err);
      setPageNotice({
        severity: 'error',
        message: `Error unpublishing item from series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`,
      });
    } finally {
      setUnpublishingItemId(null);
      setUnpublishTarget(null);
    }
  }, [fetchSeriesData, seriesId]);

  // Custom modifier to restrict drag to container bounds
  const restrictToContainer: Modifier = ({ transform, draggingNodeRect, containerNodeRect: _containerNodeRect }) => {
    if (!containerRef.current || !draggingNodeRect) {
      return transform;
    }

    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate the bounds
    const minY = containerRect.top - draggingNodeRect.top;
    const maxY = containerRect.bottom - draggingNodeRect.bottom;

    return {
      ...transform,
      y: Math.min(Math.max(transform.y, minY), maxY),
    };
  };

  // DnD sensors for drag-and-drop sorting
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Check if order has changed from original
  const hasOrderChanges = items.length !== originalItemsRef.current.length ||
    items.some((item, index) => item.displayId !== originalItemsRef.current[index]?.displayId);

  // Handle drag end to reorder items
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((prevItems) => {
        const oldIndex = prevItems.findIndex((item) => item.displayId === active.id);
        const newIndex = prevItems.findIndex((item) => item.displayId === over.id);

        return arrayMove(prevItems, oldIndex, newIndex).map((item, i, source) => ({
          ...item,
          position: source.length - i,
        }));
      });
    }
  }, []);

  // Revert to original order
  const revertOrder = () => {
    setItems(cloneSeriesDisplayItems(originalItemsRef.current));
  };

  // Save order changes
  const saveOrderChanges = useCallback(async () => {
    if (!series || !hasOrderChanges) return;

    setIsSaving(true);
    const previousItems = cloneSeriesDisplayItems(originalItemsRef.current);
    try {
      // If series is published to Subsplash, use the reorder function
      if (series.subsplashId && remoteSeriesState) {
        const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>(
          'reorderseriesitems'
        );
        const remoteItems = getRemoteDisplayItems(items);
        const remoteItemsMissingIds = remoteItems.filter(
          (item) => !item.remoteMediaItemId
        );
        if (remoteItemsMissingIds.length > 0) {
          throw new Error('One or more remote items are missing Subsplash IDs. Refresh and try again.');
        }

        const reorderResult = await reorderFunction({
          firestoreSeriesId: seriesId,
          expectedRemoteMembershipHash: remoteSeriesState.remoteMembershipHash,
          itemOrder: remoteItems.map((item, index) => ({
            mediaItemId: item.remoteMediaItemId || '',
            position: remoteItems.length - index,
          })),
          operationKey: createOperationKey('series-admin-reorder', seriesId),
        });
        if (reorderResult.status !== 'success') {
          throw new Error(reorderResult.message || 'Subsplash reorder failed.');
        }
      }

      // Persist order in Firestore only after Subsplash succeeds.
      await Promise.all(
        items
          .filter((item) => Boolean(item.sermonId))
          .map(async (item, index) => {
            const itemRef = doc(firestore, `series/${seriesId}/seriesItems`, item.sermonId as string);
            try {
              await updateDoc(itemRef, { position: items.length - index });
            } catch (err: unknown) {
              // Item might have been deleted by another user - skip it
              if (getErrorField(err, 'code') === 'not-found' || getErrorMessage(err, '').includes('NOT_FOUND')) {
                console.warn(`SeriesItem ${item.sermonId} not found - may have been removed`);
              } else {
                throw err;
              }
            }
          })
      );

      // Update original order reference after successful save
      originalItemsRef.current = cloneSeriesDisplayItems(items);
      await fetchSeriesData();
    } catch (err: unknown) {
      console.error('Error saving order:', err);
      setItems(previousItems);
      reportHandledError(err, {
        area: 'admin-series-details',
        action: 'save-order',
        extras: {
          seriesId,
        },
      });
      alert(`Error saving order. Reverted to last synced state.\n${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setIsSaving(false);
    }
  }, [fetchSeriesData, getRemoteDisplayItems, hasOrderChanges, items, remoteSeriesState, series, seriesId]);

  const executeRemoveItem = async () => {
    if (!removeTarget || isRemovingItem) {
      return;
    }

    setIsRemovingItem(true);
    try {
      const mediaItemId = removeTarget.remoteMediaItemId || removeTarget.sermonSubsplashId || removeTarget.sermon?.subsplashId;
      if (series?.subsplashId && removeTarget.canUnpublish && mediaItemId) {
        const removeFromSeriesCallable = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        try {
          await removeFromSeriesCallable({
            mediaItemId,
            operationKey: createOperationKey('series-admin-remove-item', removeTarget.id),
          });
        } catch (removeErr: unknown) {
          if (getErrorField(removeErr, 'code') !== 'functions/not-found') {
            throw removeErr;
          }
        }
      }

      if (removeTarget.sermonId) {
        await deleteDoc(doc(firestore, `series/${seriesId}/seriesItems`, removeTarget.sermonId));

        try {
          await updateDoc(doc(firestore, 'sermons', removeTarget.sermonId), {
            seriesId: null,
          });
        } catch (sermonErr: unknown) {
          if (getErrorField(sermonErr, 'code') === 'not-found' || getErrorMessage(sermonErr, '').includes('NOT_FOUND')) {
            console.warn(`Sermon ${removeTarget.sermonId} not found - may have been deleted`);
          } else {
            throw sermonErr;
          }
        }
      }
      await fetchSeriesData();
      setSelectedSeriesItemIds((previousSelected) => {
        const nextSelected = new Set(previousSelected);
        nextSelected.delete(removeTarget.displayId);
        return nextSelected;
      });
      setRemoveTarget(null);
    } catch (err: unknown) {
      console.error('Error removing item:', err);
      reportHandledError(err, {
        area: 'admin-series-details',
        action: 'remove-item',
        extras: {
          seriesId,
          targetDisplayId: removeTarget.displayId,
          targetSermonId: removeTarget.sermonId,
        },
      });
      alert(`Error removing item: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setIsRemovingItem(false);
    }
  };

  const bulkRemoveTargets = items.filter(
    (item) => selectedSeriesItemIds.has(item.displayId)
  );

  const removeSeriesItems = useCallback(async (targets: SeriesDisplayItem[]) => {
    if (targets.length === 0) {
      return;
    }

    setIsRemovingItem(true);
    try {
      for (const target of targets) {
        const mediaItemId = target.remoteMediaItemId || target.sermonSubsplashId || target.sermon?.subsplashId;
        if (series?.subsplashId && target.canUnpublish && mediaItemId) {
          const removeFromSeriesCallable = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
          try {
            await removeFromSeriesCallable({
              mediaItemId,
              operationKey: createOperationKey('series-admin-remove-item', target.displayId),
            });
          } catch (removeErr: unknown) {
            if (getErrorField(removeErr, 'code') !== 'functions/not-found') {
              throw removeErr;
            }
          }
        }
      }

      const batch = writeBatch(firestore);
      targets.forEach((target) => {
        if (!target.sermonId) {
          return;
        }
        batch.delete(doc(firestore, `series/${seriesId}/seriesItems`, target.sermonId));
        batch.update(doc(firestore, 'sermons', target.sermonId), {
          seriesId: null,
        });
      });
      await batch.commit();

      setSelectedSeriesItemIds(new Set());
      await fetchSeriesData();
      setRemoveTarget(null);
    } catch (err: unknown) {
      console.error('Error removing item:', err);
      reportHandledError(err, {
        area: 'admin-series-details',
        action: 'bulk-remove-items',
        extras: {
          seriesId,
          targetDisplayIds: targets.map((target) => target.displayId),
        },
      });
      alert(`Error removing item: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setIsRemovingItem(false);
    }
  }, [fetchSeriesData, series?.subsplashId, seriesId]);

  const handleToggleSelected = useCallback((displayId: string, checked: boolean) => {
    setSelectedSeriesItemIds((previousSelected) => {
      const nextSelected = new Set(previousSelected);
      if (checked) {
        nextSelected.add(displayId);
      } else {
        nextSelected.delete(displayId);
      }
      return nextSelected;
    });
  }, []);

  const handleOpenSermon = useCallback((id: string) => {
    void router.push(`/admin/sermons/${id}`);
  }, [router]);

  // Add item to series
  const addItemToSeries = useCallback(async (sermon: Sermon): Promise<boolean> => {
    try {
      if (items.some((item) => item.sermonId === sermon.id)) {
        return false;
      }
      const latestPositionSnapshot = await getDocs(
        query(
          collection(firestore, `series/${seriesId}/seriesItems`),
          orderBy('position', 'desc'),
          limit(1)
        )
      );
      const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
      const newPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;

      const sermonDoc = await getDoc(doc(firestore, 'sermons', sermon.id));
      if (!sermonDoc.exists()) {
        reportHandledMessage('This sermon no longer exists. It may have been deleted.', {
          area: 'admin-series-details',
          action: 'add-item-missing-sermon',
          level: 'warning',
          extras: {
            seriesId,
            sermonId: sermon.id,
          },
        });
        alert('This sermon no longer exists. It may have been deleted.');
        setAvailableSermons((previousSermons) => previousSermons.filter((candidate) => candidate.id !== sermon.id));
        return false;
      }

      const latestSermon = { ...sermonDoc.data(), id: sermon.id } as Sermon;
      const previousSeriesId = latestSermon.seriesId ?? null;
      const existingSeriesItemDoc = await getDoc(doc(firestore, `series/${seriesId}/seriesItems`, latestSermon.id));
      if (existingSeriesItemDoc.exists()) {
        await fetchSeriesData();
        return true;
      }
      if (previousSeriesId && previousSeriesId !== seriesId) {
        throw new Error(`${latestSermon.title} is already assigned to another series. Refresh and retry.`);
      }
      if (!isAdmin && latestSermon.uploaderId !== user?.uid) {
        throw new Error('You do not have permission to add this sermon to the series.');
      }
      if (!canEditSermonMetadata(latestSermon)) {
        throw new Error('This sermon cannot be added to a series while audio is queued or processing.');
      }

      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId));
      if (!seriesDoc.exists()) {
        reportHandledMessage('This series no longer exists. Redirecting to series list.', {
          area: 'admin-series-details',
          action: 'add-item-missing-series',
          level: 'warning',
          extras: {
            seriesId,
            sermonId: sermon.id,
          },
        });
        alert('This series no longer exists. Redirecting to series list.');
        router.push('/admin/series');
        return false;
      }
      if (!isAdmin && seriesDoc.data()?.ownerId !== user?.uid) {
        throw new Error('You do not have permission to update this series.');
      }

      const seriesItemData: Partial<SeriesItem> = {
        id: latestSermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        ...(latestSermon.subsplashId !== undefined && { sermonSubsplashId: latestSermon.subsplashId }),
      };

      await setDoc(
        doc(firestore, `series/${seriesId}/seriesItems`, latestSermon.id),
        {
          ...seriesItemData,
          addedAt: serverTimestamp(),
        }
      );

      await updateDoc(doc(firestore, 'sermons', latestSermon.id), {
        seriesId,
      });

      const newItem: SeriesDisplayItem = createLocalDisplayItem({
        id: latestSermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        sermonSubsplashId: latestSermon.subsplashId,
        addedAt: null,
        sermon: { ...latestSermon, seriesId },
      });

      // Keep state fully consistent: if sermon is already in Subsplash, immediately publish it to series too.
      if (isSermonPublishedToSubsplash(latestSermon)) {
        const publishResult = await publishItemToSeries(newItem, {
          suppressAlert: true,
          orderSourceItems: [newItem, ...items],
        });
        if (!publishResult.ok) {
          await deleteDoc(doc(firestore, `series/${seriesId}/seriesItems`, latestSermon.id));
          await updateDoc(doc(firestore, 'sermons', latestSermon.id), { seriesId: previousSeriesId });
          if (publishResult.error) {
            throw publishResult.error;
          }
          throw new Error(
            `${latestSermon.title} is already published to Subsplash, but automatic series publish failed. The sermon was not added to this series.`
          );
        }
      }

      await fetchSeriesData();

      return true;
    } catch (err: unknown) {
      if (isExpectedSeriesManagementError(err)) {
        console.warn('Series item add was blocked:', err);
      } else {
        console.error('Error adding item:', err);
        reportHandledError(err, {
          area: 'admin-series-details',
          action: 'add-item',
          extras: {
            seriesId,
            sermonId: sermon.id,
          },
        });
      }
      alert(`Error adding item: ${getErrorMessage(err, 'Unknown error')}`);
      return false;
    }
  }, [fetchSeriesData, isAdmin, isSermonPublishedToSubsplash, items, publishItemToSeries, router, seriesId, user?.uid]);

  const addSelectedSermons = useCallback(async () => {
    if (isAddingSelectedSermons) {
      return;
    }

    const sermonsToAdd = availableSermons
      .filter((sermon) => selectedSermonIds.has(sermon.id))
      .filter((sermon) => !items.some((item) => item.sermonId === sermon.id));

    if (sermonsToAdd.length === 0) {
      return;
    }

    setIsAddingSelectedSermons(true);
    let localAdditionsForRollback: Array<{ sermonId: string; previousSeriesId: string | null }> = [];
    try {
      if (sermonsToAdd.length === 1) {
        setActiveAddingSermonId(sermonsToAdd[0].id);
        const added = await addItemToSeries(sermonsToAdd[0]);
        if (added) {
          setSermonSearchQuery('');
          setSelectedSermonIds(new Set());
          setAddItemPopup(false);
        }
        return;
      }

      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId));
      if (!seriesDoc.exists()) {
        reportHandledMessage('This series no longer exists. Redirecting to series list.', {
          area: 'admin-series-details',
          action: 'bulk-add-missing-series',
          level: 'warning',
          extras: {
            seriesId,
            sermonIds: sermonsToAdd.map((sermon) => sermon.id),
          },
        });
        alert('This series no longer exists. Redirecting to series list.');
        router.push('/admin/series');
        return;
      }
      if (!isAdmin && seriesDoc.data()?.ownerId !== user?.uid) {
        throw new Error('You do not have permission to update this series.');
      }

      const latestSermonDocs = await Promise.all(
        sermonsToAdd.map(async (sermon) => {
          const sermonSnapshot = await getDoc(doc(firestore, 'sermons', sermon.id));
          if (!sermonSnapshot.exists()) {
            throw new Error(`${sermon.title} no longer exists. Refresh and retry.`);
          }
          return { ...sermonSnapshot.data(), id: sermon.id } as Sermon;
        })
      );
      const existingItemIds = new Set(items.map((item) => item.sermonId).filter((itemId): itemId is string => Boolean(itemId)));
      const existingSeriesItemSnapshots = await Promise.all(
        latestSermonDocs.map((sermon) => getDoc(doc(firestore, `series/${seriesId}/seriesItems`, sermon.id)))
      );
      const freshExistingItemIds = new Set(
        existingSeriesItemSnapshots
          .filter((snapshot) => snapshot.exists())
          .map((snapshot) => snapshot.id)
      );
      const alreadyAssignedSermon = latestSermonDocs.find((sermon) => Boolean(sermon.seriesId && sermon.seriesId !== seriesId));
      if (alreadyAssignedSermon) {
        throw new Error(`${alreadyAssignedSermon.title} is already assigned to another series. Refresh and retry.`);
      }

      const freshSermonsToAdd = latestSermonDocs.filter((sermon) =>
        !existingItemIds.has(sermon.id) &&
        !freshExistingItemIds.has(sermon.id) &&
        sermon.seriesId !== seriesId
      );

      if (freshSermonsToAdd.length === 0) {
        setSermonSearchQuery('');
        setSelectedSermonIds(new Set());
        setAddItemPopup(false);
        return;
      }

      const blockedSermon = freshSermonsToAdd.find((sermon) =>
        (!isAdmin && sermon.uploaderId !== user?.uid) || !canEditSermonMetadata(sermon)
      );
      if (blockedSermon) {
        throw new Error(
          !canEditSermonMetadata(blockedSermon)
            ? `${blockedSermon.title} cannot be added while audio is queued or processing.`
            : `You do not have permission to add ${blockedSermon.title} to this series.`
        );
      }

      const currentMaxPosition = items.length > 0
        ? Math.max(...items.map((item) => item.position))
        : 0;

      const additions = freshSermonsToAdd.map((sermon, index, source) => ({
        sermon,
        previousSeriesId: sermon.seriesId ?? null,
        position: currentMaxPosition + (source.length - index),
      }));

      const willPublishExistingSubsplashItems = additions.some(({ sermon }) => isSermonPublishedToSubsplash(sermon));
      const latestRemoteSeriesState = willPublishExistingSubsplashItems ? await fetchRemoteSeriesState() : null;
      if (
        latestRemoteSeriesState &&
        remoteSeriesState &&
        createFreshRemoteMembershipHash(latestRemoteSeriesState) !== createFreshRemoteMembershipHash(remoteSeriesState)
      ) {
        throw new Error(SERIES_REMOTE_MEMBERSHIP_CHANGED_MESSAGE);
      }

      const MAX_SERMONS_PER_BATCH = 200;
      for (let index = 0; index < additions.length; index += MAX_SERMONS_PER_BATCH) {
        const chunk = additions.slice(index, index + MAX_SERMONS_PER_BATCH);
        const batch = writeBatch(firestore);

        chunk.forEach(({ sermon, position }) => {
          batch.set(
            doc(firestore, `series/${seriesId}/seriesItems`, sermon.id),
            {
              id: sermon.id,
              position,
              publishedToSubsplash: false,
              ...(sermon.subsplashId !== undefined && { sermonSubsplashId: sermon.subsplashId }),
              addedAt: serverTimestamp(),
            }
          );
          batch.update(doc(firestore, 'sermons', sermon.id), {
            seriesId,
          });
        });

        await batch.commit();
      }
      localAdditionsForRollback = additions.map(({ sermon, previousSeriesId }) => ({
        sermonId: sermon.id,
        previousSeriesId,
      }));

      const newItems = additions.map(({ sermon, position }) => createLocalDisplayItem({
        id: sermon.id,
        position,
        publishedToSubsplash: false,
        sermonSubsplashId: sermon.subsplashId,
        addedAt: null,
        sermon: { ...sermon, seriesId },
      }));
      const orderedNewItems = [...newItems].sort((a, b) => b.position - a.position);

      const publishedCandidates = orderedNewItems.filter((seriesItem) => isSermonPublishedToSubsplash(seriesItem.sermon));
      if (publishedCandidates.length > 0) {
        const priorSeriesIdsBySermonId = new Map(additions.map((entry) => [entry.sermon.id, entry.previousSeriesId]));
        const mediaItemIdBySermonId = new Map<string, string>();
        for (const seriesItem of publishedCandidates) {
          if (!seriesItem.sermon || !seriesItem.sermonId) {
            throw new Error(`Sermon details missing for ${seriesItem.displayId}.`);
          }

          setActiveAddingSermonId(seriesItem.displayId);
          const mediaItemId = seriesItem.sermon.subsplashId
            ? seriesItem.sermon.subsplashId
            : await uploadSermonToSubsplash(seriesItem.sermon);
          mediaItemIdBySermonId.set(seriesItem.sermonId, mediaItemId);
        }

        const seriesSubsplashId = await ensureSeriesSubsplashId();
        const remoteStateForPublish = latestRemoteSeriesState ?? await fetchRemoteSeriesState();
        const reorderedItems = [...orderedNewItems, ...items];
        const publishedItemOrder = getPublishedRemoteOrderWithAdditions(
          reorderedItems,
          remoteStateForPublish,
          mediaItemIdBySermonId
        );

        if (publishedItemOrder.length === 0) {
          throw new Error('Cannot publish to series because one or more published sermons are missing Subsplash media IDs.');
        }

        const expectedPublishedMembershipHash = createFreshRemoteMembershipHash(remoteStateForPublish);

        const bulkAdds = publishedCandidates.map((item) => {
          const mediaItemId = item.sermonId ? mediaItemIdBySermonId.get(item.sermonId) : undefined;
          if (!mediaItemId) {
            throw new Error(`Cannot publish sermon ${item.displayId} because it is missing a Subsplash media ID.`);
          }

          return {
            sermonId: item.sermonId,
            mediaItemId,
          };
        });
        const intentFingerprint = [
          ...bulkAdds.map((entry) => `${entry.sermonId}:${entry.mediaItemId}`).sort(),
          `order:${publishedItemOrder.join(',')}`,
          `snapshot:${expectedPublishedMembershipHash}`,
        ].join('|');
        const operationKey = createRetryIntentKey('series-admin-bulk-add', seriesId, intentFingerprint);

        const bulkAddToSeriesFunction = createFunctionV2<BulkAddToSeriesInputType, BulkAddToSeriesOutputType>('bulkaddtoseries');
        const bulkResult = await bulkAddToSeriesFunction({
          firestoreSeriesId: seriesId,
          seriesSubsplashId,
          operationKey,
          expectedPublishedMembershipHash,
          adds: bulkAdds,
          publishedItemOrder,
          maxConcurrency: 4,
          rollbackOnFailure: true,
        });

        if (bulkResult.status !== 'success' || bulkResult.failed > 0 || !bulkResult.reorderApplied) {
          const rolledBackMediaItemIds = new Set(bulkResult.rolledBackMediaItemIds || []);
          const resultBySermonId = new Map(
            bulkResult.results
              .filter((result) => Boolean(result.sermonId))
              .map((result) => [result.sermonId as string, result])
          );

          const idsToRemoveLocally = new Set<string>();
          const idsToKeepPublished = new Set<string>();
          const titlesToRetry: string[] = [];
          const titlesKeptPublished: string[] = [];

          publishedCandidates.forEach((seriesItem) => {
            const mediaItemId = seriesItem.sermonId ? mediaItemIdBySermonId.get(seriesItem.sermonId) : undefined;
            const result = seriesItem.sermonId ? resultBySermonId.get(seriesItem.sermonId) : undefined;
            const wasAdded = result?.status === 'success';
            const wasRolledBack = mediaItemId ? rolledBackMediaItemIds.has(mediaItemId) : false;

            if (wasAdded && !wasRolledBack) {
              if (seriesItem.sermonId) {
                idsToKeepPublished.add(seriesItem.sermonId);
              }
              titlesKeptPublished.push(seriesItem.sermon?.title || seriesItem.displayId);
            } else {
              if (seriesItem.sermonId) {
                idsToRemoveLocally.add(seriesItem.sermonId);
              }
              titlesToRetry.push(seriesItem.sermon?.title || seriesItem.displayId);
            }
          });

          if (idsToRemoveLocally.size > 0) {
            const rollbackBatch = writeBatch(firestore);
            idsToRemoveLocally.forEach((sermonId) => {
              rollbackBatch.delete(doc(firestore, `series/${seriesId}/seriesItems`, sermonId));
              rollbackBatch.update(doc(firestore, 'sermons', sermonId), {
                seriesId: priorSeriesIdsBySermonId.get(sermonId) ?? null,
              });
            });
            await rollbackBatch.commit();
          }

          if (idsToKeepPublished.size > 0) {
            const keepBatch = writeBatch(firestore);
            idsToKeepPublished.forEach((sermonId) => {
              const mediaItemId = mediaItemIdBySermonId.get(sermonId);
              keepBatch.set(
                doc(firestore, `series/${seriesId}/seriesItems`, sermonId),
                {
                  publishedToSubsplash: true,
                  sermonSubsplashId: mediaItemId,
                },
                { merge: true }
              );
            });
            await keepBatch.commit();
          }

          setSelectedSermonIds(new Set(idsToRemoveLocally));

          setAddItemNotice({
            severity: 'warning',
            message:
              `Automatic Subsplash series publish did not fully complete. ${bulkResult.message}` +
              `${titlesToRetry.length > 0 ? ` Items removed locally: ${titlesToRetry.join(', ')}.` : ''}` +
              `${titlesKeptPublished.length > 0 ? ` Items kept published: ${titlesKeptPublished.join(', ')}.` : ''}` +
              `${bulkResult.rollbackFailures.length > 0 ? ` Rollback failures: ${bulkResult.rollbackFailures.map((failure) => `${failure.mediaItemId}: ${failure.error}`).join(' | ')}.` : ''}`,
          });
          return;
        }

        localAdditionsForRollback = [];
        const publishBatch = writeBatch(firestore);
        const publishedSermonIds = new Set<string>();
        bulkResult.results.forEach((result) => {
          if (result.status !== 'success' || !result.sermonId) {
            return;
          }
          publishedSermonIds.add(result.sermonId);
          publishBatch.set(
            doc(firestore, `series/${seriesId}/seriesItems`, result.sermonId),
            {
              publishedToSubsplash: true,
              sermonSubsplashId: result.mediaItemId,
            },
            { merge: true }
          );
        });
        await publishBatch.commit();
        localAdditionsForRollback = [];
      }

      localAdditionsForRollback = [];
      if (orderedNewItems.length > 0) {
        setSermonSearchQuery('');
        setSelectedSermonIds(new Set());
        setAddItemNotice(publishedCandidates.length > 0
          ? {
              severity: 'success',
              message: 'Items were added to the series and published memberships were synced where possible.',
            }
          : {
              severity: 'success',
              message: 'Items were added to the series.',
            });
        setAddItemPopup(false);
      }
      await fetchSeriesData();
    } catch (err: unknown) {
      if (localAdditionsForRollback.length > 0) {
        try {
          const rollbackBatch = writeBatch(firestore);
          localAdditionsForRollback.forEach(({ sermonId, previousSeriesId }) => {
            rollbackBatch.delete(doc(firestore, `series/${seriesId}/seriesItems`, sermonId));
            rollbackBatch.update(doc(firestore, 'sermons', sermonId), {
              seriesId: previousSeriesId,
            });
          });
          await rollbackBatch.commit();
        } catch (rollbackError) {
          console.error('Failed to roll back local series additions after publish failure:', rollbackError);
        }
      }

      if (isExpectedSeriesManagementError(err)) {
        console.warn('Selected sermon add was blocked:', err);
      } else {
        console.error('Error adding selected sermons:', err);
      }
      setAddItemNotice({
        severity: 'error',
        message: `Error adding selected sermons: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`,
      });
    } finally {
      setActiveAddingSermonId(null);
      setIsAddingSelectedSermons(false);
    }
  }, [
    addItemToSeries,
    availableSermons,
    createFreshRemoteMembershipHash,
    ensureSeriesSubsplashId,
    fetchRemoteSeriesState,
    isAddingSelectedSermons,
    isSermonPublishedToSubsplash,
    isAdmin,
    items,
    router,
    selectedSermonIds,
    seriesId,
    fetchSeriesData,
    getPublishedRemoteOrderWithAdditions,
    uploadSermonToSubsplash,
    user?.uid,
  ]);

  // Delete series
  const handleDeleteSeries = async () => {
    if (!series) return;

    setIsDeleting(true);
    try {
      // Always use callable so remote unlink/verify/delete semantics are enforced.
      const deleteSeriesCallable = createFunctionV2<DeleteSeriesInputType, DeleteSeriesOutputType>('deleteseries');
      await deleteSeriesCallable({
        firestoreId: seriesId,
        operationKey: createOperationKey('series-admin-delete-series', seriesId),
      });
      router.push('/admin/series');
    } catch (err: unknown) {
      console.error('Error deleting series:', err);
      reportHandledError(err, {
        area: 'admin-series-details',
        action: 'delete-series',
        extras: {
          seriesId,
        },
      });
      alert(`Error deleting series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    }
    setIsDeleting(false);
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <Alert severity="error" sx={{ maxWidth: 400 }}>
          {error}
        </Alert>
      </Box>
    );
  }

  if (!series) {
    return null;
  }

  const title = series.name || 'Series Details';
  const publishedItemsCount = items.filter((item) => item.publishedToSubsplash).length;
  const derivedSeriesSubtitle = `${publishedItemsCount} part series`;
  const selectableItems = items.filter((item) => item.canRemoveLocally || item.isSubsplashOnlyPlaceholder);
  const removableItemsCount = selectableItems.length;
  const allRemovableItemsSelected = removableItemsCount > 0 && selectableItems
    .every((item) => selectedSeriesItemIds.has(item.displayId));
  const someRemovableItemsSelected = selectableItems
    .some((item) => selectedSeriesItemIds.has(item.displayId));
  const filteredAddableSermons = availableSermons
    .filter((sermon) => !items.some((item) => item.sermonId === sermon.id))
    .filter((sermon) => (
      !sermonSearchQuery ||
      sermon.title.toLowerCase().includes(sermonSearchQuery.toLowerCase())
    ));
  const displayedAddableSermons = filteredAddableSermons;
  const selectedSermonCount = selectedSermonIds.size;
  const allVisibleSermonsSelected = filteredAddableSermons.length > 0 &&
    filteredAddableSermons.every((sermon) => selectedSermonIds.has(sermon.id));
  const someVisibleSermonsSelected = filteredAddableSermons.some((sermon) => selectedSermonIds.has(sermon.id));
  const listActionsDisabled = isSaving || isAddingSelectedSermons || isRemovingItem;

  return (
    <>
      <Head>
        <title>{title} | Upper Room Media</title>
        <meta property="og:title" content={title} key="title" />
      </Head>

      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        {/* Breadcrumbs */}
        <Breadcrumbs
          separator={<NavigateNextIcon fontSize="small" />}
          sx={{
            mb: 3,
            overflow: 'hidden',
            '& .MuiBreadcrumbs-ol': {
              flexWrap: 'nowrap',
            },
            '& .MuiBreadcrumbs-li': {
              minWidth: 0,
            },
          }}
        >
          <Link href="/admin/series" passHref>
            <Typography
              component="span"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                color: 'text.secondary',
                cursor: 'pointer',
                '&:hover': { color: 'primary.main' },
              }}
            >
              <CollectionsIcon fontSize="small" />
              Series
            </Typography>
          </Link>
          <Typography color="text.primary" fontWeight={500}>
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                maxWidth: { xs: 180, sm: 'none' },
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                verticalAlign: 'bottom',
              }}
            >
              {series.name}
            </Box>
          </Typography>
        </Breadcrumbs>

        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            gap: 2,
            mb: 4,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
            <Link href="/admin/series">
              <IconButton
                sx={{
                  bgcolor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                  '&:hover': { borderColor: 'primary.main' },
                }}
              >
                <ArrowBackIcon />
              </IconButton>
            </Link>
            <Typography
              variant="h4"
              fontWeight={700}
              sx={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: { xs: '1.35rem', sm: '2.125rem' },
              }}
            >
              {series.name}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => setEditPopup(true)}
              size="medium"
              fullWidth
            >
              Edit
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setDeletePopup(true)}
              size="medium"
              fullWidth
            >
              Delete
            </Button>
          </Stack>
        </Box>

        {/* Series Info Card */}
        <Card
          sx={{
            mb: 4,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            position: 'relative',
            overflow: 'visible',
            '&::before': {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 4,
              background: `linear-gradient(90deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.light} 100%)`,
              borderRadius: '12px 12px 0 0',
            },
          }}
        >
          <CardContent sx={{ p: { xs: 2, sm: 3, md: 4 } }}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: { xs: 2, sm: 3 },
              }}
            >
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" color="text.secondary" sx={{ mb: 1, fontWeight: 400 }}>
                  {derivedSeriesSubtitle}
                </Typography>
                {series.summary && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.7 }}>
                    {series.summary}
                  </Typography>
                )}
                <Box
                  sx={{
                    display: 'flex',
                    gap: { xs: 1.5, sm: 4 },
                    pt: 2,
                    borderTop: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Box
                    sx={{
                      width: 1,
                      display: 'flex',
                      flexDirection: { xs: 'column', sm: 'row' },
                      alignItems: { xs: 'flex-start', sm: 'stretch' },
                      gap: { xs: 1.5, sm: 2 },
                    }}
                  >

                    <Box
                      sx={{
                        display: 'flex',
                        gap: { xs: 2, sm: 4 },
                      }}
                    >
                      <Box>
                        <Typography variant="h5" fontWeight={700} color="primary.main">
                          {items.length}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Total Items
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="h5" fontWeight={700} color="success.main">
                          {publishedItemsCount}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Published
                        </Typography>
                      </Box>
                    </Box>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: { xs: 0, sm: 2 }, minWidth: 0 }}>
                      {series.subsplashId ? (
                        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.75, minWidth: 0 }}>
                          <Chip
                            icon={<CheckCircleIcon />}
                            label="Published to Subsplash"
                            color="success"
                            size="small"
                            sx={{
                              maxWidth: '100%',
                              '& .MuiChip-label': {
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              },
                            }}
                          />
                          <Box
                            component="a"
                            href={`https://dashboard.subsplash.com/-d/#/library/media/series/${series.subsplashId}`}
                            target="_blank"
                            rel="noreferrer"
                            sx={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 0.5,
                              color: 'primary.main',
                              textDecoration: 'none',
                              maxWidth: '100%',
                              '&:hover': {
                                textDecoration: 'underline',
                              },
                            }}
                          >
                            <Typography
                              variant="body2"
                              color="inherit"
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              View in Subsplash
                            </Typography>
                            <OpenInNewIcon sx={{ fontSize: 16 }} />
                          </Box>
                        </Box>
                      ) : (
                        <Chip
                          icon={<PendingIcon />}
                          label="Not Published"
                          color="warning"
                          size="small"
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              </Box>
              {series.images?.some((image) => Boolean(image.downloadLink)) && (
                <DetailImageGallery images={series.images} altName={series.name} />
              )}
            </Box>
          </CardContent>
        </Card>

        {/* Items Section Header */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'flex-start', sm: 'center' },
            gap: 2,
            mb: 3,
          }}
        >
          <Typography variant="h5" fontWeight={600}>
            Series Items
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ width: { xs: '100%', sm: 'auto' } }}>
            {removableItemsCount > 0 && (
              <FormControlLabel
                sx={{ mr: 0, minWidth: 0 }}
                control={(
                  <Checkbox
                    checked={allRemovableItemsSelected}
                    indeterminate={!allRemovableItemsSelected && someRemovableItemsSelected}
                    onChange={(event) => {
                      if (isRemovingItem) {
                        return;
                      }
                      if (event.target.checked) {
                        setSelectedSeriesItemIds(new Set(
                          items
                            .filter((item) => item.canRemoveLocally || item.isSubsplashOnlyPlaceholder)
                            .map((item) => item.displayId)
                        ));
                      } else {
                        setSelectedSeriesItemIds(new Set());
                      }
                    }}
                    disabled={isRemovingItem}
                  />
                )}
                label={`${selectedSeriesItemIds.size} selected`}
              />
            )}
            {hasOrderChanges && (
              <>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<UndoIcon />}
                  onClick={revertOrder}
                  disabled={isSaving}
                >
                  Revert
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={isSaving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                  onClick={saveOrderChanges}
                  disabled={isSaving}
                >
                  Save Order
                </Button>
              </>
            )}
            {selectedSeriesItemIds.size > 0 && (
              <Button
                variant="outlined"
                color="error"
                startIcon={isRemovingItem ? <CircularProgress size={18} color="inherit" /> : <DeleteIcon />}
                onClick={() => setRemoveTarget(bulkRemoveTargets[0] || null)}
                disabled={isRemovingItem}
              >
                Remove Selected
              </Button>
            )}
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => {
                fetchAvailableSermons();
                setSermonSearchQuery('');
                setSelectedSermonIds(new Set());
                setAddItemNotice(null);
                setAddItemPopup(true);
              }}
            >
              Add Item
            </Button>
          </Stack>
        </Box>

        {pageNotice ? (
          <Alert severity={pageNotice.severity} sx={{ mb: 3 }}>
            {pageNotice.message}
          </Alert>
        ) : null}

        {/* Items List */}
        {items.length === 0 ? (
          <Card
            sx={{
              textAlign: 'center',
              py: 6,
              px: 3,
              border: '2px dashed',
              borderColor: 'divider',
              bgcolor: 'transparent',
            }}
          >
            <CollectionsIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No items in this series yet
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
              Add sermons to this series to organize your content
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                fetchAvailableSermons();
                setSermonSearchQuery('');
                setSelectedSermonIds(new Set());
                setAddItemNotice(null);
                setAddItemPopup(true);
              }}
            >
              Add Your First Item
            </Button>
          </Card>
        ) : (
          <Card ref={containerRef} sx={{ overflow: 'hidden' }}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToVerticalAxis, restrictToContainer]}
            >
              <SortableContext
                items={items.map((item) => item.displayId)}
                strategy={verticalListSortingStrategy}
              >
                {items.map((item, index) => (
                  <Box key={item.displayId}>
                    <SortableItem
                      item={item}
                      index={index}
                      isSelected={selectedSeriesItemIds.has(item.displayId)}
                      onToggleSelected={handleToggleSelected}
                      onOpenSermon={handleOpenSermon}
                      onRequestPublish={publishItemToSeries}
                      onRequestUnpublish={setUnpublishTarget}
                      isPublishing={publishingItemId === item.id}
                      isUnpublishing={unpublishingItemId === item.id}
                      actionsDisabled={listActionsDisabled}
                      canPublish={!item.isSubsplashOnlyPlaceholder && canPublishSermonToSeries(item.sermon)}
                      publishBlockedReason={SERIES_PUBLISH_BLOCKED_MESSAGE}
                    />
                    {index < items.length - 1 && <Divider />}
                  </Box>
                ))}
              </SortableContext>
            </DndContext>
          </Card>
        )}
      </Box>

      {/* Edit Series Popup */}
      <NewSeriesPopup
        open={editPopup}
        setOpen={setEditPopup}
        existingSeries={series}
        onSeriesCreated={(updatedSeries) => {
          setSeries(updatedSeries);
        }}
      />

      {/* Delete Confirmation Popup */}
      <DeleteEntityPopup
        entityBeingDeleted="series"
        handleDelete={handleDeleteSeries}
        deleteConfirmationPopup={deletePopup}
        setDeleteConfirmationPopup={setDeletePopup}
        isDeleting={isDeleting}
      />

      <Dialog
        open={Boolean(removeTarget)}
        onClose={() => !isRemovingItem && setRemoveTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove Item From Series?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {selectedSeriesItemIds.size > 1
              ? `${selectedSeriesItemIds.size} sermons will be removed from this series.`
              : `"${removeTarget?.sermon?.title || removeTarget?.remoteTitle || 'This item'}" will be removed from this series.`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)} disabled={isRemovingItem}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (selectedSeriesItemIds.size > 1) {
                void removeSeriesItems(bulkRemoveTargets);
                return;
              }
              void executeRemoveItem();
            }}
            startIcon={isRemovingItem ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon fontSize="small" />}
            disabled={isRemovingItem}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(unpublishTarget)}
        onClose={() => !unpublishingItemId && setUnpublishTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Unpublish From Series?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {unpublishTarget?.sermon?.title || 'This sermon'} will be removed from the Subsplash series,
            but will stay in this app series.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnpublishTarget(null)} disabled={Boolean(unpublishingItemId)}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              if (unpublishTarget) {
                unpublishItemFromSeries(unpublishTarget);
              }
            }}
            startIcon={unpublishingItemId ? <CircularProgress size={16} color="inherit" /> : <CloudOffIcon fontSize="small" />}
            disabled={!!unpublishingItemId}
          >
            Unpublish
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add Item Dialog */}
      <Dialog
        open={addItemPopup}
        onClose={closeAddItemDialog}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            maxHeight: '80vh',
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          Add Item to Series
        </DialogTitle>
        <DialogContent>
          {addItemNotice ? (
            <Alert severity={addItemNotice.severity} sx={{ mt: 1, mb: 2 }}>
              {addItemNotice.message}
            </Alert>
          ) : null}
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1, mb: 1 }}>
            <FormControlLabel
              label="Select all visible"
              control={(
                <Checkbox
                  checked={allVisibleSermonsSelected}
                  indeterminate={!allVisibleSermonsSelected && someVisibleSermonsSelected}
                  onChange={(event) => {
                    if (isAddingSelectedSermons) {
                      return;
                    }
                    setSelectedSermonIds((previousSelected) => {
                      const nextSelected = new Set(previousSelected);
                      if (event.target.checked) {
                        filteredAddableSermons.forEach((sermon) => nextSelected.add(sermon.id));
                      } else {
                        filteredAddableSermons.forEach((sermon) => nextSelected.delete(sermon.id));
                      }
                      return nextSelected;
                    });
                  }}
                  disabled={isAddingSelectedSermons || filteredAddableSermons.length === 0}
                />
              )}
            />
            <Chip
              size="small"
              color={selectedSermonCount > 0 ? 'primary' : 'default'}
              label={`${selectedSermonCount} selected`}
            />
          </Stack>

          <TextField
            fullWidth
            size="small"
            placeholder="Search sermons by title..."
            value={sermonSearchQuery}
            onChange={(e) => setSermonSearchQuery(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
          />
          {loadingSermons ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : filteredAddableSermons.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography color="text.secondary">
                {availableSermons.length === 0
                  ? 'No available sermons to add. Upload some sermons first!'
                  : `No sermons found matching "${sermonSearchQuery}".`}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
              {displayedAddableSermons.map((sermon, index) => {
                const isSelected = selectedSermonIds.has(sermon.id);
                const previousSelected = index > 0 && selectedSermonIds.has(displayedAddableSermons[index - 1].id);
                const nextSelected = index < displayedAddableSermons.length - 1
                  && selectedSermonIds.has(displayedAddableSermons[index + 1].id);

                return (
                  <Box
                    key={sermon.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      p: 1.5,
                      mt: isSelected && previousSelected ? '-1px' : 0,
                      border: '1px solid',
                      borderColor: isSelected ? 'primary.main' : 'transparent',
                      borderTopLeftRadius: isSelected && !previousSelected ? 8 : 0,
                      borderTopRightRadius: isSelected && !previousSelected ? 8 : 0,
                      borderBottomLeftRadius: isSelected && !nextSelected ? 8 : 0,
                      borderBottomRightRadius: isSelected && !nextSelected ? 8 : 0,
                      cursor: isAddingSelectedSermons ? 'default' : 'pointer',
                      transition: 'background-color 0.15s ease, border-color 0.15s ease',
                      bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                      '&:hover': {
                        bgcolor: isAddingSelectedSermons
                          ? 'transparent'
                          : (isSelected
                            ? alpha(theme.palette.primary.main, 0.12)
                            : 'action.hover'),
                      },
                    }}
                    onClick={() => {
                      if (isAddingSelectedSermons) {
                        return;
                      }
                      setSelectedSermonIds((previousSelectedIds) => {
                        const nextSelectedIds = new Set(previousSelectedIds);
                        if (nextSelectedIds.has(sermon.id)) {
                          nextSelectedIds.delete(sermon.id);
                        } else {
                          nextSelectedIds.add(sermon.id);
                        }
                        return nextSelectedIds;
                      });
                    }}
                  >
                    <Checkbox
                      checked={isSelected}
                      disabled={isAddingSelectedSermons}
                      onChange={(event) => {
                        event.stopPropagation();
                        if (isAddingSelectedSermons) {
                          return;
                        }
                        setSelectedSermonIds((previousSelectedIds) => {
                          const nextSelectedIds = new Set(previousSelectedIds);
                          if (event.target.checked) {
                            nextSelectedIds.add(sermon.id);
                          } else {
                            nextSelectedIds.delete(sermon.id);
                          }
                          return nextSelectedIds;
                        });
                      }}
                    />
                    <AvatarWithDefaultImage
                      image={sermon.images?.find((img) => img.type === 'square')}
                      altName={sermon.title}
                      width={48}
                      height={48}
                      borderRadius={6}
                    />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        fontWeight={500}
                        sx={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {sermon.title}
                      </Typography>
                      {sermon.dateString && (
                        <Typography variant="caption" color="text.secondary">
                          {sermon.dateString}
                        </Typography>
                      )}
                    </Box>
                    <IconButton size="small" color="primary" disabled>
                      {activeAddingSermonId === sermon.id
                        ? <CircularProgress size={16} />
                        : <AddIcon />}
                    </IconButton>
                  </Box>
                );
              })}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={closeAddItemDialog}
            disabled={isAddingSelectedSermons}
          >
            Close
          </Button>
          <Button
            variant="contained"
            startIcon={isAddingSelectedSermons ? <CircularProgress size={16} color="inherit" /> : <AddIcon fontSize="small" />}
            disabled={selectedSermonCount === 0 || isAddingSelectedSermons}
            onClick={addSelectedSermons}
          >
            {isAddingSelectedSermons
              ? 'Adding...'
              : `Add ${selectedSermonCount} sermon${selectedSermonCount === 1 ? '' : 's'}`}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

const ProtectedSeriesDetailsPage = () => {
  const { user } = useAuth();

  if (!user?.canPublish()) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <Typography color="text.secondary">
          You don&apos;t have permission to view this page.
        </Typography>
      </Box>
    );
  }

  return <SeriesDetailsPage />;
};

ProtectedSeriesDetailsPage.PageLayout = AppLayout;

export default ProtectedSeriesDetailsPage;
