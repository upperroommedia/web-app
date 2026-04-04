import { FunctionComponent, ReactElement, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import RefreshIcon from '@mui/icons-material/Refresh';
import { alpha, useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  writeBatch,
} from '../firebase/firestore';
import { isDevelopment } from '../firebase/firebase';
import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { Series, seriesConverter } from '../types/Series';
import { SermonList, sermonListConverter } from '../types/SermonList';
import { createFunctionV2 } from '../utils/createFunction';
import { parseLockBusyDetails } from '../utils/callableConcurrency';
import { resolveCanonicalFirestoreList } from '../utils/resolveCanonicalFirestoreList';
import {
  createSubsplashListAddIntentKey,
  createSubsplashListCreateIntentKey,
  createSubsplashListRemoveIntentKey,
  createSubsplashSeriesCreateIntentKey,
  createSubsplashSeriesPublishIntentKey,
  createSubsplashSeriesReorderIntentKey,
  createSubsplashSeriesRollbackIntentKey,
  createSubsplashSeriesUnpublishIntentKey,
  createSubsplashUploadIntentKey,
  didAllListPublishesSucceed,
  getSermonSubsplashStatusAfterListMutation,
  summarizeListPublishErrors,
} from '../utils/subsplashPublishFlow';
import { runSubsplashSeriesPublishSaga } from '../utils/subsplashSeriesPublishSaga';
import { canPublishSermonToSeries, SERIES_PUBLISH_BLOCKED_MESSAGE } from '../utils/seriesPublishUtils';
import { summarizeAdvancedSelectionChanges } from '../utils/sermonPublishActions';
import { getSquareImageDownloadLink } from '../utils/utils';
import { getSoundCloudRecoveryMessage, isSoundCloudReconnectRequiredClientError } from '../utils/soundcloudAuthRecovery';
import { PublishDestinationState, getListsDestinationState, summarizePublishRun } from '../utils/sermonPublishingUi';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import type { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '@upperroom/contracts/uploadToSoundCloud';
import type { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '@upperroom/contracts/uploadToSubsplash';
import type { AddtoListInputType, AddToListOutputType } from '@upperroom/contracts/addToList';
import type { RemoveFromListInputType, RemoveFromListOutputType } from '@upperroom/contracts/removeFromList';
import type {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '@upperroom/contracts/createNewSubsplashList';
import type { CreateSeriesInputType, CreateSeriesOutputType } from '@upperroom/contracts/createSeries';
import type { AddToSeriesInputType, AddToSeriesOutputType } from '@upperroom/contracts/addToSeries';
import type { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '@upperroom/contracts/removeFromSeries';
import type { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '@upperroom/contracts/reorderSeriesItems';
import useAuth from '../context/user/UserContext';

interface SermonPublishPanelProps {
  sermon: Sermon;
  onUpdate?: () => void;
  onBusyStateChange?: (busy: boolean) => void;
  onRequestAddToSeries?: () => void;
  initialAdvancedOpen?: boolean;
}

type NoticeState = {
  severity: 'success' | 'info' | 'warning' | 'error';
  message: string;
} | null;

type ListPublishResult = {
  status: 'success' | 'error';
  mediaItemId?: string;
  error?: string;
};

type SeriesPublishResult = {
  status: 'success' | 'error';
  error?: string;
};

type ActionPlan = {
  label: string;
  run: () => Promise<void>;
  disabled: boolean;
  pendingLabel: string;
  color: 'primary' | 'error' | 'warning';
  icon: ReactNode;
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

const getErrorField = (error: unknown, field: 'code' | 'details' | 'message'): string | undefined => {
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

const areSetsEqual = (left: Set<string>, right: Set<string>): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
};

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
          borderColor: alpha(theme.palette.success.main, 0.32),
          color: theme.palette.success.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.success.main },
        },
      };
    case 'publishing':
      return {
        sx: {
          bgcolor: alpha(theme.palette.info.main, 0.12),
          borderColor: alpha(theme.palette.info.main, 0.32),
          color: theme.palette.info.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.info.main },
        },
      };
    case 'partial':
    case 'blocked':
      return {
        sx: {
          bgcolor: alpha(theme.palette.warning.main, 0.14),
          borderColor: alpha(theme.palette.warning.main, 0.34),
          color: theme.palette.warning.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.warning.main },
        },
      };
    case 'error':
      return {
        sx: {
          bgcolor: alpha(theme.palette.error.main, 0.12),
          borderColor: alpha(theme.palette.error.main, 0.3),
          color: theme.palette.error.dark,
          '& .MuiChip-deleteIcon': { color: theme.palette.error.main },
        },
      };
    default:
      return {
        sx: {
          bgcolor: theme.palette.background.paper,
          borderColor: alpha(theme.palette.divider, 1),
          color: theme.palette.text.secondary,
          '& .MuiChip-deleteIcon': { color: theme.palette.text.secondary },
        },
      };
  }
};

const StatusChip: FunctionComponent<{
  label: string;
  status: PublishDestinationState;
  avatar?: ReactElement;
  tooltip?: ReactNode;
  onRetry?: () => void;
  retryDisabled?: boolean;
}> = ({ label, status, avatar, tooltip, onRetry, retryDisabled = false }) => {
  const theme = useTheme();
  const tone = getStatusTone(status, theme);
  const chip = (
    <Chip
      avatar={avatar}
      label={label}
      variant="outlined"
      onDelete={onRetry}
      deleteIcon={
        onRetry ? (retryDisabled ? <CircularProgress size={14} /> : <RefreshIcon fontSize="small" />) : undefined
      }
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

const SoundCloudChipAvatar = () => {
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

const SermonPublishPanel: FunctionComponent<SermonPublishPanelProps> = ({
  sermon,
  onUpdate,
  onBusyStateChange,
  onRequestAddToSeries: _onRequestAddToSeries,
  initialAdvancedOpen = false,
}) => {
  const { user } = useAuth();
  const theme = useTheme();
  const [advancedOpen, setAdvancedOpen] = useState(initialAdvancedOpen);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesPublished, setSeriesPublished] = useState(false);
  const [soundCloudError, setSoundCloudError] = useState<ReactNode | null>(null);
  const [destinationErrors, setDestinationErrors] = useState<{
    lists?: string;
    series?: string;
    soundcloud?: string;
  }>({});
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState(false);
  const [isUploadingToSubsplash, setIsUploadingToSubsplash] = useState(false);
  const [isPublishingToSeries, setIsPublishingToSeries] = useState(false);
  const [isPublishingEverywhere, setIsPublishingEverywhere] = useState(false);
  const [selectedListIds, setSelectedListIds] = useState<Set<string>>(new Set());
  const [selectedSeriesEnabled, setSelectedSeriesEnabled] = useState(false);
  const [selectedSoundCloudEnabled, setSelectedSoundCloudEnabled] = useState(false);

  const [listArrayFirestore, loading, listError] = useCollectionData(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter)
  );
  const listArray = useMemo(() => listArrayFirestore ?? [], [listArrayFirestore]);
  const { selectedListsToPublish, selectedPublishedLists, deselectedPublishedLists } = useMemo(() => {
    const nextSelectedListsToPublish: SermonList[] = [];
    const nextSelectedPublishedLists: SermonList[] = [];
    const nextDeselectedPublishedLists: SermonList[] = [];

    for (const list of listArray) {
      const isSelected = selectedListIds.has(list.id);
      const isUploaded = list.uploadStatus?.status === uploadStatus.UPLOADED;

      if (isSelected && isUploaded) {
        nextSelectedPublishedLists.push(list);
        continue;
      }

      if (isSelected) {
        nextSelectedListsToPublish.push(list);
        continue;
      }

      if (isUploaded) {
        nextDeselectedPublishedLists.push(list);
      }
    }

    return {
      selectedListsToPublish: nextSelectedListsToPublish,
      selectedPublishedLists: nextSelectedPublishedLists,
      deselectedPublishedLists: nextDeselectedPublishedLists,
    };
  }, [listArray, selectedListIds]);

  const isBusy =
    isUploadingToSoundCloud ||
    isUploadingToSubsplash ||
    isPublishingToSeries ||
    isPublishingEverywhere;

  useEffect(() => {
    onBusyStateChange?.(isBusy);
  }, [isBusy, onBusyStateChange]);

  useEffect(() => {
    if (listArray.length === 0) {
      setSelectedListIds((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }

    setSelectedListIds((previous) => {
      const next = new Set<string>();
      listArray.forEach((list) => {
        if (previous.size === 0 || previous.has(list.id)) {
          next.add(list.id);
        }
      });

      return areSetsEqual(previous, next) ? previous : next;
    });
  }, [listArray]);

  useEffect(() => {
    setSelectedSeriesEnabled(Boolean(sermon.seriesId));
  }, [sermon.seriesId]);

  useEffect(() => {
    setSelectedSoundCloudEnabled(true);
  }, [sermon.id]);

  useEffect(() => {
    let cancelled = false;

    const fetchSeries = async () => {
      if (!sermon.seriesId) {
        setSeries(null);
        setSeriesPublished(false);
        return;
      }

      setSeriesLoading(true);
      try {
        const seriesDoc = await getDoc(doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter));
        if (!cancelled) {
          setSeries(seriesDoc.exists() ? seriesDoc.data() : null);
        }

        const seriesItemDoc = await getDoc(doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id));
        if (!cancelled) {
          setSeriesPublished(seriesItemDoc.exists() && seriesItemDoc.data()?.publishedToSubsplash === true);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error fetching series:', error);
          setDestinationErrors((previous) => ({
            ...previous,
            series: getErrorMessage(error, 'Failed to load series publish state.'),
          }));
        }
      } finally {
        if (!cancelled) {
          setSeriesLoading(false);
        }
      }
    };

    fetchSeries();

    return () => {
      cancelled = true;
    };
  }, [sermon.id, sermon.seriesId]);

  const isSoundCloudUploaded = sermon.status.soundCloud === uploadStatus.UPLOADED;
  const canPublishToSeries = canPublishSermonToSeries(sermon);
  const hasPublishedDestinations =
    selectedPublishedLists.length > 0 ||
    deselectedPublishedLists.length > 0 ||
    seriesPublished ||
    isSoundCloudUploaded;

  const soundCloudStatus: PublishDestinationState = useMemo(() => {
    if (isUploadingToSoundCloud || (isPublishingEverywhere && !isSoundCloudUploaded)) {
      return {
        state: 'publishing',
        label: 'Publishing',
        details: 'Sending sermon to SoundCloud.',
      };
    }

    if (soundCloudError) {
      return {
        state: 'error',
        label: 'Needs attention',
        details: isSoundCloudUploaded ? 'Published, but the last update failed.' : 'SoundCloud publish failed.',
        error: typeof soundCloudError === 'string' ? soundCloudError : undefined,
      };
    }

    if (isDevelopment) {
      return {
        state: 'blocked',
        label: 'Disabled in dev',
        details: 'SoundCloud publishing is disabled in local development.',
      };
    }

    if (isSoundCloudUploaded) {
      return {
        state: 'published',
        label: 'Published',
        ...(sermon.soundCloudTrackUrl
          ? { details: 'Track is live on SoundCloud.' }
          : { details: 'Track published to SoundCloud.' }),
      };
    }

    return {
      state: 'not_published',
      label: 'Not published',
      details: 'Will be included in Publish Everywhere.',
    };
  }, [isPublishingEverywhere, isSoundCloudUploaded, isUploadingToSoundCloud, sermon.soundCloudTrackUrl, soundCloudError]);

  const listsStatus = useMemo<PublishDestinationState>(() => {
    if (isUploadingToSubsplash || isPublishingEverywhere) {
      return {
        state: 'publishing',
        label: 'Publishing',
        details: 'Syncing sermon to Subsplash lists.',
      };
    }

    const baseState = getListsDestinationState(listArrayFirestore, {
      loading,
      error: listError?.message ?? destinationErrors.lists ?? null,
    });

    if (destinationErrors.lists && baseState.state !== 'error') {
      return {
        ...baseState,
        state: baseState.state === 'published' ? 'partial' : 'error',
        error: destinationErrors.lists,
      };
    }

    return baseState;
  }, [destinationErrors.lists, isPublishingEverywhere, isUploadingToSubsplash, listArrayFirestore, listError?.message, loading]);

  const seriesStatus = useMemo<PublishDestinationState>(() => {
    if (seriesLoading) {
      return {
        state: 'publishing',
        label: 'Loading',
        details: 'Checking series publish state.',
      };
    }

    if (!sermon.seriesId) {
      return {
        state: 'not_configured',
        label: 'No series assigned',
        details: 'Assign a series only when this sermon should be part of one.',
      };
    }

    if (isPublishingToSeries || isPublishingEverywhere) {
      return {
        state: 'publishing',
        label: 'Publishing',
        details: seriesPublished ? 'Updating series membership.' : 'Syncing sermon into its series.',
      };
    }

    if (destinationErrors.series) {
      return {
        state: 'error',
        label: 'Needs attention',
        details: series?.name || 'Series publish failed.',
        error: destinationErrors.series,
      };
    }

    if (!canPublishToSeries && !seriesPublished) {
      return {
        state: 'blocked',
        label: 'Blocked',
        details: SERIES_PUBLISH_BLOCKED_MESSAGE,
      };
    }

    if (seriesPublished) {
      return {
        state: 'published',
        label: 'Published',
        details: series ? `${series.name} is synced to Subsplash.` : 'Series membership is published.',
      };
    }

    return {
      state: 'not_published',
      label: 'Not published',
      details: series ? `${series.name} is assigned and ready.` : 'Series is assigned and ready.',
    };
  }, [
    canPublishToSeries,
    destinationErrors.series,
    isPublishingEverywhere,
    isPublishingToSeries,
    series,
    seriesLoading,
    seriesPublished,
    sermon.seriesId,
  ]);

  const setNoticeFromRun = useCallback((statuses: PublishDestinationState[]) => {
    const summary = summarizePublishRun(statuses);
    setNotice({
      severity: summary.state === 'success' ? 'success' : summary.state === 'partial' ? 'warning' : 'error',
      message: summary.message,
    });
  }, []);

  const uploadToSoundCloud = useCallback(async (): Promise<SeriesPublishResult> => {
    setIsUploadingToSoundCloud(true);
    setSoundCloudError(null);
    setDestinationErrors((previous) => ({ ...previous, soundcloud: undefined }));

    const uploadToSoundCloudFn = createFunctionV2<UploadToSoundCloudInputType, UploadToSoundCloudReturnType>('uploadtosoundcloud');

    const data: UploadToSoundCloudInputType = {
      title: sermon.title,
      description: sermon.description,
      tags: [sermon.subtitle, ...sermon.topics],
      speakers: sermon.speakers.map((speaker) => speaker.name),
      audioStoragePath: `intro-outro-sermons/${sermon.id}`,
      imageSource: getSquareImageDownloadLink(sermon),
    };

    try {
      const result = await uploadToSoundCloudFn(data);
      await updateDoc(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter), {
        soundCloudTrackId: result.soundCloudTrackId,
        soundCloudTrackUrl: result.soundCloudTrackUrl ?? deleteField(),
        'status.soundCloud': uploadStatus.UPLOADED,
      });
      onUpdate?.();
      return { status: 'success' };
    } catch (error: unknown) {
      console.error('Error uploading to SoundCloud:', error);
      const message = isSoundCloudReconnectRequiredClientError(error)
        ? getSoundCloudRecoveryMessage(user?.isAdmin() ?? false)
        : getErrorMessage(error, 'Failed to upload to SoundCloud');
      setSoundCloudError(message);
      setDestinationErrors((previous) => ({ ...previous, soundcloud: typeof message === 'string' ? message : 'Failed to upload to SoundCloud' }));
      return { status: 'error', error: typeof message === 'string' ? message : 'Failed to upload to SoundCloud' };
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [onUpdate, sermon, user]);

  const uploadToSubsplash = useCallback(async (
    listsToUploadTo: SermonList[],
    options?: { suppressNotice?: boolean }
  ): Promise<ListPublishResult> => {
    setIsUploadingToSubsplash(true);
    setDestinationErrors((previous) => ({ ...previous, lists: undefined }));

    try {
      const subsplashIdToListIdMap = new Map<string, string>();
      const uploadToSubsplashCallable = createFunctionV2<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
      const addToList = createFunctionV2<AddtoListInputType, AddToListOutputType>('addtolist');
      const uploadOperationKey = createSubsplashUploadIntentKey(
        'manage-publishing-upload',
        sermon.id,
        sermon.subsplashUploadGeneration
      );
      const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.id}`));
      const data: Omit<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, 'operationKey' | 'lockKey'> = {
        title: sermon.title,
        subtitle: sermon.subtitle,
        speakers: sermon.speakers,
        autoPublish: !isDevelopment,
        audioTitle: sermon.title,
        audioUrl: url,
        topics: sermon.topics,
        description: sermon.description,
        images: sermon.images,
        date: new Date(sermon.dateMillis),
      };

      let id = sermon.subsplashId;
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      if (!id) {
        const response = (await uploadToSubsplashCallable({
          ...data,
          operationKey: uploadOperationKey,
          lockKey: sermon.id,
        })) as unknown as { id: string };
        id = response.id;
        await updateDoc(sermonRef, { subsplashId: id });
      }

      const listsMetadata = await Promise.all(
        listsToUploadTo.map(async (list) => {
          const canonicalList = await resolveCanonicalFirestoreList(list);
          if (!canonicalList) {
            throw new Error(
              `List "${list.name}" could not be resolved to a Firestore list document.`
            );
          }

          if (canonicalList.subsplashId) {
            subsplashIdToListIdMap.set(canonicalList.subsplashId, canonicalList.id);
            return { listId: canonicalList.subsplashId, overflowBehavior: canonicalList.overflowBehavior, type: canonicalList.type };
          }

          const createNewSubsplashList = createFunctionV2<CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType>('createnewsubsplashlist');
          const { listId } = await createNewSubsplashList({
            title: canonicalList.name,
            subtitle: '',
            images: canonicalList.images,
            operationKey: createSubsplashListCreateIntentKey('manage-publishing-list-create', sermon.id, canonicalList.id),
          });
          await updateDoc(doc(firestore, `lists/${canonicalList.id}`), { subsplashId: listId });
          subsplashIdToListIdMap.set(listId, canonicalList.id);
          return { listId, overflowBehavior: canonicalList.overflowBehavior, type: canonicalList.type };
        })
      );

      const addToListReturn = listsMetadata.length === 0
        ? []
        : await addToList({
          destinationListIds: listsMetadata.map((metadata) => metadata.listId),
          mediaItem: { id, type: 'media-item' },
          operationKey: createSubsplashListAddIntentKey(
            'manage-publishing-list-add',
            sermon.id,
            listsToUploadTo.map((list) => ({
              id: list.id,
              publishGeneration: list.publishGeneration,
            }))
          ),
        });
      const targetListIds = listsMetadata.map((metadata) => metadata.listId);

      const batch = writeBatch(firestore);
      const listsById = new Map(listsToUploadTo.map((list) => [list.id, list]));

      addToListReturn.forEach((result) => {
        const listId = subsplashIdToListIdMap.get(result.listId);
        if (!listId) {
          throw new Error(`ListId for Subsplash list ${result.listId} was not found.`);
        }

        const sermonListRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${listId}`).withConverter(sermonListConverter);
        const list = listsById.get(listId);
        if (!list) {
          throw new Error(`List metadata for firestore list ${listId} not found`);
        }

        if (result.status === 'success') {
          const actualPlacement = result.actualPlacement ?? {
            firestoreListId: listId,
            subsplashListId: result.listId,
            overflowDepth: 0,
            position: 1,
            listItemId: result.listItemId,
          };
          const resolvedListItemId = actualPlacement.listItemId ?? result.listItemId;
          if (!resolvedListItemId) {
            throw new Error(`Successful list publish for ${listId} did not return a resolved listItemId.`);
          }
          batch.set(
            sermonListRef,
            {
              ...list,
              publishGeneration: list.publishGeneration ?? 0,
              uploadStatus: { status: uploadStatus.UPLOADED, listItemId: resolvedListItemId },
            },
            { merge: true }
          );
          batch.set(
            doc(firestore, 'lists', listId, 'listItems', sermon.id),
            {
              subsplashId: id,
              uploadStatus: { status: uploadStatus.UPLOADED, listItemId: resolvedListItemId },
              physicalPlacement: actualPlacement,
            },
            { merge: true }
          );
        } else {
          batch.set(
            sermonListRef,
            {
              ...list,
              publishGeneration: list.publishGeneration ?? 0,
              uploadStatus: { status: uploadStatus.ERROR, reason: result.error },
            },
            { merge: true }
          );
          batch.set(
            doc(firestore, 'lists', listId, 'listItems', sermon.id),
            {
              subsplashId: id,
              uploadStatus: { status: uploadStatus.ERROR, reason: result.error },
            },
            { merge: true }
          );
        }
      });

      const listsPublishedSuccessfully = didAllListPublishesSucceed(targetListIds, addToListReturn);
      batch.update(sermonRef, {
        'status.subsplash': getSermonSubsplashStatusAfterListMutation(targetListIds, addToListReturn),
        approverId: user?.uid,
      });
      await batch.commit();
      onUpdate?.();

      if (!listsPublishedSuccessfully) {
        const errorMessage = summarizeListPublishErrors(targetListIds, addToListReturn) || 'One or more list publishes failed.';
        setDestinationErrors((previous) => ({ ...previous, lists: errorMessage }));
        if (!options?.suppressNotice) {
          setNotice({ severity: 'warning', message: errorMessage });
        }
        return {
          status: 'error',
          mediaItemId: id,
          error: errorMessage,
        };
      }

      if (!options?.suppressNotice && listsToUploadTo.length > 0) {
        setNotice({
          severity: 'success',
          message: 'Selected lists were published successfully.',
        });
      }

      return {
        status: 'success',
        mediaItemId: id,
      };
    } catch (error: unknown) {
      console.error('Error uploading to Subsplash:', error);
      const message = getLockBusyMessage(error, getErrorMessage(error, 'Failed to publish to Subsplash.'));
      setDestinationErrors((previous) => ({ ...previous, lists: message }));
      if (!options?.suppressNotice) {
        setNotice({ severity: 'error', message });
      }
      return {
        status: 'error',
        error: message,
      };
    } finally {
      setIsUploadingToSubsplash(false);
    }
  }, [onUpdate, sermon, user?.uid]);

  const removeFromLists = useCallback(async (
    listsToRemoveFrom: SermonList[],
    options?: { suppressNotice?: boolean }
  ): Promise<ListPublishResult> => {
    const uploadedLists = listsToRemoveFrom.filter(
      (list) => list.uploadStatus?.status === uploadStatus.UPLOADED && list.uploadStatus.listItemId && list.subsplashId
    );

    if (uploadedLists.length === 0) {
      return { status: 'success', mediaItemId: sermon.subsplashId };
    }

    setIsUploadingToSubsplash(true);
    setDestinationErrors((previous) => ({ ...previous, lists: undefined }));

    try {
      const removeFromListCallable = createFunctionV2<RemoveFromListInputType, RemoveFromListOutputType>('removefromlist');
      await removeFromListCallable({
        listIds: uploadedLists.map((list) => list.subsplashId as string),
        listItemIds: uploadedLists.map((list) => list.uploadStatus?.status === uploadStatus.UPLOADED ? list.uploadStatus.listItemId : ''),
        itemIds: uploadedLists.map(() => sermon.subsplashId || sermon.id),
        itemTypes: uploadedLists.map(() => 'media-item'),
        sermonIds: uploadedLists.map(() => sermon.id),
        operationKey: createSubsplashListRemoveIntentKey(
          'manage-publishing-list-remove',
          sermon.id,
          uploadedLists.map((list) => list.subsplashId).filter((listId): listId is string => Boolean(listId))
        ),
      });
      onUpdate?.();

      if (!options?.suppressNotice) {
        setNotice({
          severity: 'info',
          message: `Unpublished from ${uploadedLists.length} list${uploadedLists.length === 1 ? '' : 's'}.`,
        });
      }

      return { status: 'success', mediaItemId: sermon.subsplashId };
    } catch (error: unknown) {
      console.error('Error removing from list:', error);
      const message = getLockBusyMessage(error, 'Failed to remove sermon from one or more Subsplash lists.');
      setDestinationErrors((previous) => ({ ...previous, lists: message }));
      if (!options?.suppressNotice) {
        setNotice({ severity: 'error', message });
      }
      return { status: 'error', error: message };
    } finally {
      setIsUploadingToSubsplash(false);
    }
  }, [onUpdate, sermon.id, sermon.subsplashId]);

  const reorderSeriesFromFirebaseOrder = useCallback(async (
    seriesId: string,
    newlyPublishedSermonId: string,
    newlyPublishedMediaItemId: string
  ): Promise<void> => {
    const orderedItemsSnapshot = await getDocs(
      query(collection(firestore, `series/${seriesId}/seriesItems`), orderBy('position', 'desc'))
    );
    const orderedItems = orderedItemsSnapshot.docs.map((seriesItemDoc) => {
      const data = seriesItemDoc.data() as {
        publishedToSubsplash?: boolean;
        sermonSubsplashId?: string;
      };

      const isPublished = seriesItemDoc.id === newlyPublishedSermonId ? true : data.publishedToSubsplash === true;
      const mediaItemId = seriesItemDoc.id === newlyPublishedSermonId ? newlyPublishedMediaItemId : data.sermonSubsplashId;
      return {
        sermonId: seriesItemDoc.id,
        isPublished,
        mediaItemId,
      };
    });

    if (!orderedItems.some((item) => item.sermonId === newlyPublishedSermonId)) {
      throw new Error('Series item is missing from Firestore order. Refresh and try again.');
    }

    const publishedItems = orderedItems.filter((item) => item.isPublished);
    const missingMediaId = publishedItems.find((item) => !item.mediaItemId);
    if (missingMediaId) {
      throw new Error(`Published series item ${missingMediaId.sermonId} is missing a Subsplash media ID.`);
    }

    const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>('reorderseriesitems');
    const reorderResult = await reorderFunction({
      firestoreSeriesId: seriesId,
      itemOrder: publishedItems.map((item, index) => ({
        mediaItemId: item.mediaItemId as string,
        position: publishedItems.length - index,
      })),
      operationKey: createSubsplashSeriesReorderIntentKey(
        'manage-publishing-series-reorder',
        seriesId,
        publishedItems.map((item) => item.mediaItemId as string)
      ),
    });

    if (reorderResult.status !== 'success') {
      throw new Error(reorderResult.message || 'Subsplash reorder failed.');
    }
  }, []);

  const publishToSeries = useCallback(async (
    options?: { mediaItemId?: string; suppressNotice?: boolean }
  ): Promise<SeriesPublishResult> => {
    if (!canPublishSermonToSeries(sermon)) {
      const message = SERIES_PUBLISH_BLOCKED_MESSAGE;
      if (!options?.suppressNotice) {
        setNotice({ severity: 'warning', message });
      }
      setDestinationErrors((previous) => ({ ...previous, series: message }));
      return { status: 'error', error: message };
    }

    const mediaItemId = options?.mediaItemId || sermon.subsplashId;
    if (!series || !mediaItemId) {
      const message = 'Sermon must be uploaded to Subsplash first before adding to series.';
      if (!options?.suppressNotice) {
        setNotice({ severity: 'error', message });
      }
      setDestinationErrors((previous) => ({ ...previous, series: message }));
      return { status: 'error', error: message };
    }

    setIsPublishingToSeries(true);
    setDestinationErrors((previous) => ({ ...previous, series: undefined }));
    try {
      let seriesSubsplashId = series.subsplashId;
      if (!seriesSubsplashId) {
        const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
        const createResult = await createSeriesFunction({
          title: series.name,
          summary: series.summary,
          ownerId: series.ownerId,
          firestoreId: series.id,
          skipSubsplash: false,
          images: series.images,
          operationKey: createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', series.id),
        });

        if (createResult.status !== 'success' || !createResult.subsplashId) {
          throw new Error(createResult.error || 'Failed to create series in Subsplash');
        }

        seriesSubsplashId = createResult.subsplashId;
        await updateDoc(doc(firestore, 'series', series.id), {
          subsplashId: seriesSubsplashId,
          status: 'published',
        });
        setSeries((previous) => previous ? { ...previous, subsplashId: seriesSubsplashId, status: 'published' } : previous);
      }

      const seriesItemRef = doc(firestore, `series/${series.id}/seriesItems`, sermon.id);
      const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
      const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
      const sagaResult = await runSubsplashSeriesPublishSaga({
        ensureSeriesSubsplashId: async () => seriesSubsplashId as string,
        addToSeries: async (resolvedSeriesSubsplashId) =>
          addToSeriesFunction({
            seriesSubsplashId: resolvedSeriesSubsplashId,
            mediaItemId,
            operationKey: createSubsplashSeriesPublishIntentKey(
              'manage-publishing-series-publish',
              sermon.id,
              series.id
            ),
          }),
        reorderSeries: async (resolvedMediaItemId) => {
          await reorderSeriesFromFirebaseOrder(series.id, sermon.id, resolvedMediaItemId);
        },
        rollbackSeriesMembership: async (resolvedMediaItemId) => {
          const rollbackResult = await removeFromSeriesFunction({
            mediaItemId: resolvedMediaItemId,
            operationKey: createSubsplashSeriesRollbackIntentKey(
              'manage-publishing-series-rollback',
              sermon.id,
              series.id
            ),
          });
          if (rollbackResult.status !== 'success') {
            throw new Error(rollbackResult.message || 'Failed to rollback series membership.');
          }
        },
        persistLocalPublished: async (resolvedMediaItemId) => {
          await setDoc(
            seriesItemRef,
            {
              publishedToSubsplash: true,
              sermonSubsplashId: resolvedMediaItemId,
            },
            { merge: true }
          );
          const verificationSnapshot = await getDoc(seriesItemRef);
          if (!verificationSnapshot.exists() || verificationSnapshot.data()?.publishedToSubsplash !== true) {
            throw new Error('Series publish did not persist locally. Please refresh and retry.');
          }
        },
        persistLocalUnpublished: async () => {
          await setDoc(
            seriesItemRef,
            {
              publishedToSubsplash: false,
              sermonSubsplashId: deleteField(),
            },
            { merge: true }
          );
        },
      });

      setSeriesPublished(sagaResult.localPublished);
      onUpdate?.();
      if (sagaResult.status !== 'success') {
        throw new Error(sagaResult.error || 'Failed to publish sermon to series.');
      }

      if (!options?.suppressNotice) {
        setNotice({
          severity: 'success',
          message: 'Series membership published successfully.',
        });
      }

      return { status: 'success' };
    } catch (error: unknown) {
      console.error('Error publishing to series:', error);
      setSeriesPublished(false);
      const message = getLockBusyMessage(error, getErrorMessage(error, 'Failed to publish to series.'));
      setDestinationErrors((previous) => ({ ...previous, series: message }));
      if (!options?.suppressNotice) {
        setNotice({ severity: 'error', message });
      }
      return { status: 'error', error: message };
    } finally {
      setIsPublishingToSeries(false);
    }
  }, [onUpdate, reorderSeriesFromFirebaseOrder, sermon, series]);

  const unpublishFromSeries = useCallback(async (
    options?: { suppressNotice?: boolean }
  ): Promise<SeriesPublishResult> => {
    if (!series) {
      return { status: 'success' };
    }

    setIsPublishingToSeries(true);
    setDestinationErrors((previous) => ({ ...previous, series: undefined }));
    try {
      const seriesItemRef = doc(firestore, `series/${series.id}/seriesItems`, sermon.id);
      const seriesItemSnapshot = await getDoc(seriesItemRef);
      const seriesItemData = seriesItemSnapshot.exists() ? (seriesItemSnapshot.data() as { sermonSubsplashId?: string }) : null;
      const mediaItemId = seriesItemData?.sermonSubsplashId || sermon.subsplashId;

      if (mediaItemId) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        await removeFromSeriesFunction({
          mediaItemId,
          operationKey: createSubsplashSeriesUnpublishIntentKey(
            'manage-publishing-series-unpublish',
            sermon.id,
            series.id
          ),
        });
      }

      if (seriesItemSnapshot.exists()) {
        await updateDoc(seriesItemRef, {
          publishedToSubsplash: false,
          sermonSubsplashId: deleteField(),
        });
      }

      setSeriesPublished(false);
      onUpdate?.();
      if (!options?.suppressNotice) {
        setNotice({
          severity: 'info',
          message: 'Series membership was unpublished.',
        });
      }
      return { status: 'success' };
    } catch (error: unknown) {
      console.error('Error unpublishing from series:', error);
      const message = getLockBusyMessage(error, getErrorMessage(error, 'Failed to unpublish from series.'));
      setDestinationErrors((previous) => ({ ...previous, series: message }));
      if (!options?.suppressNotice) {
        setNotice({ severity: 'error', message });
      }
      return { status: 'error', error: message };
    } finally {
      setIsPublishingToSeries(false);
    }
  }, [onUpdate, series, sermon.id, sermon.subsplashId]);

  const deleteFromSoundCloud = useCallback(async (
    options?: { suppressNotice?: boolean }
  ): Promise<SeriesPublishResult> => {
    if (!sermon.soundCloudTrackId) {
      return { status: 'success' };
    }

    setIsUploadingToSoundCloud(true);
    setSoundCloudError(null);
    setDestinationErrors((previous) => ({ ...previous, soundcloud: undefined }));

    const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
    const deleteFromSoundCloudFn = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');

    try {
      await deleteFromSoundCloudFn({ soundCloudTrackId: sermon.soundCloudTrackId });
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        soundCloudTrackUrl: deleteField(),
        'status.soundCloud': uploadStatus.NOT_UPLOADED,
      });
      onUpdate?.();
      if (!options?.suppressNotice) {
        setNotice({
          severity: 'info',
          message: 'SoundCloud publish was removed.',
        });
      }
      return { status: 'success' };
    } catch (error: unknown) {
      if (getErrorField(error, 'details')?.includes('Invalid track id')) {
        await updateDoc(sermonRef, {
          soundCloudTrackId: deleteField(),
          soundCloudTrackUrl: deleteField(),
          'status.soundCloud': uploadStatus.NOT_UPLOADED,
        });
        onUpdate?.();
        return { status: 'success' };
      }

      console.error('Error deleting from SoundCloud:', error);
      const message = isSoundCloudReconnectRequiredClientError(error)
        ? getSoundCloudRecoveryMessage(user?.isAdmin() ?? false)
        : getErrorMessage(error, 'Failed to remove from SoundCloud');
      setSoundCloudError(message);
      setDestinationErrors((previous) => ({ ...previous, soundcloud: typeof message === 'string' ? message : 'Failed to remove from SoundCloud' }));
      if (!options?.suppressNotice) {
        setNotice({
          severity: 'error',
          message: typeof message === 'string' ? message : 'Failed to remove from SoundCloud',
        });
      }
      return { status: 'error', error: typeof message === 'string' ? message : 'Failed to remove from SoundCloud' };
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [onUpdate, sermon.id, sermon.soundCloudTrackId, user]);

  const publishEverywhere = useCallback(async () => {
    if (isPublishingEverywhere) {
      return;
    }

    setIsPublishingEverywhere(true);
    setNotice(null);
    setDestinationErrors({});
    setSoundCloudError(null);

    const nextStatuses: PublishDestinationState[] = [];
    try {
      let mediaItemId = sermon.subsplashId;

      if (selectedListsToPublish.length > 0) {
        const listResult = await uploadToSubsplash(selectedListsToPublish, { suppressNotice: true });
        if (listResult.status === 'success') {
          mediaItemId = listResult.mediaItemId || mediaItemId;
          nextStatuses.push({
            state: 'published',
            label: 'Published',
            details: `Published to ${selectedListsToPublish.length} list${selectedListsToPublish.length === 1 ? '' : 's'}.`,
          });
        } else {
          nextStatuses.push({
            state: 'error',
            label: 'List publish failed',
            error: listResult.error,
          });
        }
      } else if (listArray.length > 0 && selectedListIds.size === 0) {
        nextStatuses.push({
          state: 'not_configured',
          label: 'Lists skipped',
          details: 'All list targets were skipped in advanced publish config.',
        });
      } else {
        nextStatuses.push(listsStatus);
      }

      if (sermon.seriesId) {
        if (!seriesPublished && canPublishToSeries) {
          if (!mediaItemId) {
            const prepResult = await uploadToSubsplash([], { suppressNotice: true });
            if (prepResult.status === 'success') {
              mediaItemId = prepResult.mediaItemId || mediaItemId;
            } else {
              nextStatuses.push({
                state: 'error',
                label: 'Series publish failed',
                error: prepResult.error,
              });
            }
          }

          if (mediaItemId) {
            const seriesResult = await publishToSeries({ mediaItemId, suppressNotice: true });
            if (seriesResult.status === 'success') {
              nextStatuses.push({
                state: 'published',
                label: 'Published',
                details: series ? `${series.name} was published.` : 'Series membership was published.',
              });
            } else {
              nextStatuses.push({
                state: canPublishToSeries ? 'error' : 'blocked',
                label: canPublishToSeries ? 'Series publish failed' : 'Series publish blocked',
                error: seriesResult.error,
              });
            }
          }
        } else {
          nextStatuses.push(seriesStatus);
        }
      } else {
        nextStatuses.push(seriesStatus);
      }

      if (!isDevelopment && !isSoundCloudUploaded) {
        const soundCloudResult = await uploadToSoundCloud();
        nextStatuses.push(
          soundCloudResult.status === 'success'
            ? {
                state: 'published',
                label: 'Published',
                details: 'SoundCloud track uploaded successfully.',
              }
            : {
                state: 'error',
                label: 'SoundCloud publish failed',
                error: soundCloudResult.error,
              }
        );
      } else {
        nextStatuses.push(soundCloudStatus);
      }

      setNoticeFromRun(nextStatuses);
    } finally {
      setIsPublishingEverywhere(false);
    }
  }, [
    canPublishToSeries,
    isPublishingEverywhere,
    isSoundCloudUploaded,
    listArray.length,
    listsStatus,
    publishToSeries,
    selectedListIds.size,
    selectedListsToPublish,
    series,
    seriesPublished,
    seriesStatus,
    sermon.seriesId,
    sermon.subsplashId,
    setNoticeFromRun,
    soundCloudStatus,
    uploadToSoundCloud,
    uploadToSubsplash,
  ]);

  const unpublishEverywhere = useCallback(async () => {
    if (isPublishingEverywhere) {
      return;
    }

    setIsPublishingEverywhere(true);
    setNotice(null);
    setDestinationErrors({});
    setSoundCloudError(null);

    try {
      const hadPublishedLists = selectedPublishedLists.length + deselectedPublishedLists.length > 0;
      const hadSeries = seriesPublished;
      const hadSoundCloud = isSoundCloudUploaded;
      let hadError = false;

      if (hadPublishedLists) {
        const listResult = await removeFromLists([...selectedPublishedLists, ...deselectedPublishedLists], { suppressNotice: true });
        if (listResult.status === 'error') {
          hadError = true;
        }
      }

      if (hadSeries) {
        const seriesResult = await unpublishFromSeries({ suppressNotice: true });
        if (seriesResult.status === 'error') {
          hadError = true;
        }
      }

      if (hadSoundCloud) {
        const soundCloudResult = await deleteFromSoundCloud({ suppressNotice: true });
        if (soundCloudResult.status === 'error') {
          hadError = true;
        }
      }

      setNotice({
        severity: hadError ? 'warning' : 'success',
        message: hadError
          ? 'Unpublish everywhere partially succeeded. Review the destination statuses below.'
          : 'Unpublished everywhere successfully.',
      });
    } finally {
      setIsPublishingEverywhere(false);
    }
  }, [
    deleteFromSoundCloud,
    deselectedPublishedLists,
    isPublishingEverywhere,
    isSoundCloudUploaded,
    removeFromLists,
    selectedPublishedLists,
    seriesPublished,
    unpublishFromSeries,
  ]);

  const selectedSeriesToPublish = selectedSeriesEnabled && sermon.seriesId && !seriesPublished && canPublishToSeries;
  const selectedSeriesToUnpublish = Boolean(selectedSeriesEnabled === false && sermon.seriesId && seriesPublished);
  const selectedSoundCloudToPublish = selectedSoundCloudEnabled && !isDevelopment && !isSoundCloudUploaded;
  const selectedSoundCloudToUnpublish = selectedSoundCloudEnabled === false && isSoundCloudUploaded;

  const applyAdvancedListChanges = useCallback(async () => {
    if (isPublishingEverywhere) {
      return;
    }

    setIsPublishingEverywhere(true);
    setNotice(null);
    setDestinationErrors((previous) => ({ ...previous, lists: undefined, series: undefined, soundcloud: undefined }));

    try {
      const actionMessages: string[] = [];
      let hadError = false;

      if (selectedListsToPublish.length > 0) {
        const publishResult = await uploadToSubsplash(selectedListsToPublish, { suppressNotice: true });
        if (publishResult.status === 'success') {
          actionMessages.push(`published to ${selectedListsToPublish.length} list${selectedListsToPublish.length === 1 ? '' : 's'}`);
        } else {
          hadError = true;
        }
      }

      if (deselectedPublishedLists.length > 0) {
        const unpublishResult = await removeFromLists(deselectedPublishedLists, { suppressNotice: true });
        if (unpublishResult.status === 'success') {
          actionMessages.push(`unpublished from ${deselectedPublishedLists.length} list${deselectedPublishedLists.length === 1 ? '' : 's'}`);
        } else {
          hadError = true;
        }
      }

      if (selectedSeriesToPublish) {
        const seriesResult = await publishToSeries({ suppressNotice: true });
        if (seriesResult.status === 'success') {
          actionMessages.push('published to series');
        } else {
          hadError = true;
        }
      }

      if (selectedSeriesToUnpublish) {
        const seriesResult = await unpublishFromSeries({ suppressNotice: true });
        if (seriesResult.status === 'success') {
          actionMessages.push('unpublished from series');
        } else {
          hadError = true;
        }
      }

      if (selectedSoundCloudToPublish) {
        const soundCloudResult = await uploadToSoundCloud();
        if (soundCloudResult.status === 'success') {
          actionMessages.push('published to SoundCloud');
        } else {
          hadError = true;
        }
      }

      if (selectedSoundCloudToUnpublish) {
        const soundCloudResult = await deleteFromSoundCloud({ suppressNotice: true });
        if (soundCloudResult.status === 'success') {
          actionMessages.push('unpublished from SoundCloud');
        } else {
          hadError = true;
        }
      }

      if (hadError) {
        setNotice({
          severity: 'warning',
          message: 'Destination changes partially succeeded. Review the statuses below.',
        });
        return;
      }

      if (actionMessages.length > 0) {
        setNotice({
          severity: 'success',
          message: `Destination selection updated: ${actionMessages.join(' and ')}.`,
        });
      }
    } finally {
      setIsPublishingEverywhere(false);
    }
  }, [
    deleteFromSoundCloud,
    deselectedPublishedLists,
    isPublishingEverywhere,
    publishToSeries,
    removeFromLists,
    selectedListsToPublish,
    selectedSeriesToPublish,
    selectedSeriesToUnpublish,
    selectedSoundCloudToPublish,
    selectedSoundCloudToUnpublish,
    unpublishFromSeries,
    uploadToSoundCloud,
    uploadToSubsplash,
  ]);

  const retryFailedSteps = useCallback(async () => {
    const failedLists = listsStatus.state === 'error' || listsStatus.state === 'partial';
    const failedSeries = seriesStatus.state === 'error' || seriesStatus.state === 'blocked';
    const failedSoundCloud = soundCloudStatus.state === 'error';

    if (failedLists || failedSeries || failedSoundCloud) {
      await publishEverywhere();
    }
  }, [listsStatus.state, publishEverywhere, seriesStatus.state, soundCloudStatus.state]);

  const hasFailures = [listsStatus, seriesStatus, soundCloudStatus].some((status) =>
    ['partial', 'error'].includes(status.state)
  );

  const retrySingleList = useCallback(
    async (list: SermonList) => {
      await uploadToSubsplash([list], { suppressNotice: true });
    },
    [uploadToSubsplash]
  );

  const listChipTooltip = useCallback(
    (list: SermonList): ReactNode => {
      const isSkipped = !selectedListIds.has(list.id);
      if (isSkipped && list.uploadStatus?.status === uploadStatus.UPLOADED) {
        return 'Currently published. It will be unpublished when you apply these list changes.';
      }
      if (isSkipped) {
        return 'Skipped by the current list selection.';
      }
      if (list.uploadStatus?.status === uploadStatus.ERROR) {
        return list.uploadStatus.reason;
      }
      if (list.uploadStatus?.status === uploadStatus.UPLOADED) {
        return 'Published successfully.';
      }
      return 'Ready to publish.';
    },
    [selectedListIds]
  );

  const getListChipStatus = useCallback(
    (list: SermonList): PublishDestinationState => {
      if (isPublishingEverywhere && selectedListsToPublish.some((selectedList) => selectedList.id === list.id)) {
        return {
          state: 'publishing',
          label: 'Publishing',
        };
      }
      if (list.uploadStatus?.status === uploadStatus.UPLOADED) {
        return { state: 'published', label: 'Published' };
      }
      if (list.uploadStatus?.status === uploadStatus.ERROR) {
        return { state: 'error', label: 'Failed', error: list.uploadStatus.reason };
      }
      if (!selectedListIds.has(list.id)) {
        return {
          state: 'not_configured',
          label: 'Skipped',
        };
      }
      return { state: 'not_published', label: 'Ready' };
    },
    [isPublishingEverywhere, selectedListIds, selectedListsToPublish]
  );

  const seriesChipTooltip = destinationErrors.series || (seriesPublished ? 'Published successfully.' : seriesStatus.details);
  const canRetrySeries = Boolean(sermon.seriesId && !isBusy && seriesStatus.state === 'error');
  const canRetrySoundCloud = soundCloudStatus.state === 'error' && !isBusy;
  const advancedSelectionSummary = useMemo(() => summarizeAdvancedSelectionChanges({
    publishListCount: selectedListsToPublish.length,
    unpublishListCount: deselectedPublishedLists.length,
    publishSeries: Boolean(selectedSeriesToPublish),
    unpublishSeries: selectedSeriesToUnpublish,
    publishSoundCloud: selectedSoundCloudToPublish,
    unpublishSoundCloud: selectedSoundCloudToUnpublish,
  }), [
    deselectedPublishedLists.length,
    selectedListsToPublish.length,
    selectedSeriesToPublish,
    selectedSeriesToUnpublish,
    selectedSoundCloudToPublish,
    selectedSoundCloudToUnpublish,
  ]);

  const currentActionPlan = useMemo<ActionPlan>(() => {
    if (advancedOpen) {
      return {
        label: advancedSelectionSummary.label,
        run: applyAdvancedListChanges,
        disabled: isBusy || !advancedSelectionSummary.hasChanges,
        pendingLabel: 'Applying Destination Changes…',
        color: advancedSelectionSummary.isMixedDirection ? 'warning' : advancedSelectionSummary.isPureUnpublish ? 'error' : 'primary',
        icon: advancedSelectionSummary.isMixedDirection ? <RefreshIcon /> : advancedSelectionSummary.isPureUnpublish ? <CloudOffIcon /> : <CloudUploadIcon />,
      };
    }

    if (hasPublishedDestinations) {
      return {
        label: 'Unpublish From Everywhere',
        run: unpublishEverywhere,
        disabled: isBusy,
        pendingLabel: 'Unpublishing From Everywhere…',
        color: 'error',
        icon: <CloudOffIcon />,
      };
    }

    return {
      label: 'Publish Everywhere',
      run: publishEverywhere,
      disabled: isBusy,
      pendingLabel: 'Publishing Everywhere…',
      color: 'primary',
      icon: <CloudUploadIcon />,
    };
  }, [
    advancedSelectionSummary,
    advancedOpen,
    applyAdvancedListChanges,
    hasPublishedDestinations,
    isBusy,
    publishEverywhere,
    unpublishEverywhere,
  ]);

  return (
    <Stack spacing={2.5}>
      {notice ? <Alert severity={notice.severity}>{notice.message}</Alert> : null}

      <Stack spacing={1.25}>
        <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
          >
            Lists
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {listArray.map((list) => {
              const chipStatus = getListChipStatus(list);
              const canRetryList = chipStatus.state === 'error' && !isBusy;
              return (
                <StatusChip
                  key={list.id}
                  label={list.name}
                  status={chipStatus}
                  tooltip={listChipTooltip(list)}
                  onRetry={
                    canRetryList
                      ? () => {
                          void retrySingleList(list);
                        }
                      : undefined
                  }
                  retryDisabled={isUploadingToSubsplash}
                  avatar={
                    <AvatarWithDefaultImage
                      image={list.images?.find((image) => image.type === 'square')}
                      altName={list.name}
                      width={26}
                      height={26}
                      borderRadius={999}
                    />
                  }
                />
              );
            })}
          </Box>
        </Box>

        {sermon.seriesId ? (
          <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
            >
              Series
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <StatusChip
                label={series?.name || 'Series'}
                status={seriesStatus}
                tooltip={seriesChipTooltip}
                onRetry={
                  canRetrySeries
                    ? () => {
                        void publishToSeries({ suppressNotice: true });
                      }
                    : undefined
                }
                retryDisabled={isPublishingToSeries}
                avatar={
                  <AvatarWithDefaultImage
                    image={series?.images?.find((image) => image.type === 'square')}
                    altName={series?.name || 'Series'}
                    width={26}
                    height={26}
                    borderRadius={999}
                  />
                }
              />
            </Box>
          </Box>
        ) : null}

        <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
          >
            SoundCloud
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <StatusChip
              label="SoundCloud"
              status={soundCloudStatus}
              tooltip={destinationErrors.soundcloud || soundCloudStatus.details}
              avatar={<SoundCloudChipAvatar />}
              onRetry={
                canRetrySoundCloud
                  ? () => {
                      void uploadToSoundCloud();
                    }
                  : undefined
              }
              retryDisabled={isUploadingToSoundCloud}
            />
          </Box>
        </Box>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Button
          variant="text"
          size="small"
          endIcon={<ExpandMoreIcon sx={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />}
          onClick={() => setAdvancedOpen((previous) => !previous)}
          sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
        >
          {advancedOpen ? 'Hide advanced config' : 'Advanced publish config'}
        </Button>
        {!advancedOpen ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="flex-end">
            {hasFailures ? (
              <Button
                variant="outlined"
                color="warning"
                onClick={retryFailedSteps}
                disabled={isBusy}
              >
                Retry Failed
              </Button>
            ) : null}
              <Button
                variant="contained"
                size="large"
                color={currentActionPlan.color}
                startIcon={isPublishingEverywhere ? <CircularProgress size={18} color="inherit" /> : currentActionPlan.icon}
                onClick={() => {
                  void currentActionPlan.run();
                }}
              disabled={currentActionPlan.disabled}
            >
              {isPublishingEverywhere ? currentActionPlan.pendingLabel : currentActionPlan.label}
            </Button>
          </Stack>
        ) : null}
      </Stack>

      <Collapse in={advancedOpen} timeout="auto" unmountOnExit>
        <Stack spacing={2.5} sx={{ pt: 0.5 }}>
          <Divider />

          <Stack spacing={1.25}>
            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                Lists
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
                Uncheck any published list to unpublish it. Check any ready list to publish it.
              </Typography>
              {listError ? (
                <Alert severity="error">{listError.message}</Alert>
              ) : loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                  <CircularProgress />
                </Box>
              ) : listArray.length === 0 ? (
                <Alert severity="info">This sermon is not assigned to any publish lists.</Alert>
              ) : (
                <Stack spacing={1}>
                  {listArray.map((list) => {
                    const chipStatus = getListChipStatus(list);
                    return (
                      <Box
                        key={list.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 1.5,
                          p: 1,
                          borderRadius: 2,
                          border: `1px solid ${theme.palette.divider}`,
                        }}
                      >
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={selectedListIds.has(list.id)}
                              onChange={(event) => {
                                setSelectedListIds((previous) => {
                                  const next = new Set(previous);
                                  if (event.target.checked) {
                                    next.add(list.id);
                                  } else {
                                    next.delete(list.id);
                                  }
                                  return next;
                                });
                              }}
                            />
                          }
                          label={
                            <Stack direction="row" spacing={1.25} alignItems="center">
                              <AvatarWithDefaultImage
                                image={list.images?.find((image) => image.type === 'square')}
                                altName={list.name}
                                width={34}
                                height={34}
                                borderRadius={8}
                              />
                              <Typography variant="body2">{list.name}</Typography>
                            </Stack>
                          }
                          sx={{ m: 0, flex: 1 }}
                        />
                        <StatusChip
                          label={chipStatus.label}
                          status={chipStatus}
                          tooltip={listChipTooltip(list)}
                          onRetry={
                            chipStatus.state === 'error' && !isBusy
                              ? () => {
                                  void retrySingleList(list);
                                }
                              : undefined
                          }
                          retryDisabled={isUploadingToSubsplash}
                        />
                      </Box>
                    );
                  })}
                </Stack>
              )}
            </Box>

            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                Series
              </Typography>
              {!sermon.seriesId ? (
                <Alert severity="info">This sermon is not assigned to a series.</Alert>
              ) : (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    p: 1,
                    borderRadius: 2,
                    border: `1px solid ${theme.palette.divider}`,
                  }}
                >
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={selectedSeriesEnabled}
                        onChange={(event) => {
                          setSelectedSeriesEnabled(event.target.checked);
                        }}
                      />
                    }
                    label={
                      <Stack direction="row" spacing={1.25} alignItems="center">
                        <AvatarWithDefaultImage
                          image={series?.images?.find((image) => image.type === 'square')}
                          altName={series?.name || 'Series'}
                          width={34}
                          height={34}
                          borderRadius={8}
                        />
                        <Typography variant="body2">{series?.name || 'Series'}</Typography>
                      </Stack>
                    }
                    sx={{ m: 0, flex: 1 }}
                  />
                  <StatusChip
                    label={seriesStatus.label}
                    status={seriesStatus}
                    tooltip={seriesChipTooltip}
                    onRetry={
                      canRetrySeries
                        ? () => {
                            void publishToSeries({ suppressNotice: true });
                          }
                        : undefined
                    }
                    retryDisabled={isPublishingToSeries}
                  />
                </Box>
              )}
            </Box>

            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                SoundCloud
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  p: 1,
                  borderRadius: 2,
                  border: `1px solid ${theme.palette.divider}`,
                }}
              >
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={selectedSoundCloudEnabled}
                      onChange={(event) => {
                        setSelectedSoundCloudEnabled(event.target.checked);
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <SoundCloudChipAvatar />
                      <Typography variant="body2">SoundCloud</Typography>
                    </Stack>
                  }
                  sx={{ m: 0, flex: 1 }}
                />
                <StatusChip
                  label={soundCloudStatus.label}
                  status={soundCloudStatus}
                  tooltip={destinationErrors.soundcloud || soundCloudStatus.details}
                  onRetry={
                    canRetrySoundCloud
                      ? () => {
                          void uploadToSoundCloud();
                        }
                      : undefined
                  }
                  retryDisabled={isUploadingToSoundCloud}
                />
              </Box>
            </Box>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="flex-end">
            {hasFailures ? (
              <Button
                variant="outlined"
                color="warning"
                onClick={retryFailedSteps}
                disabled={isBusy}
              >
                Retry Failed
              </Button>
            ) : null}
            <Button
              variant="contained"
              size="large"
              color={currentActionPlan.color}
              startIcon={isPublishingEverywhere ? <CircularProgress size={18} color="inherit" /> : currentActionPlan.icon}
              onClick={() => {
                void currentActionPlan.run();
              }}
              disabled={currentActionPlan.disabled}
            >
              {isPublishingEverywhere ? currentActionPlan.pendingLabel : currentActionPlan.label}
            </Button>
          </Stack>
        </Stack>
      </Collapse>
    </Stack>
  );
};

export default SermonPublishPanel;
