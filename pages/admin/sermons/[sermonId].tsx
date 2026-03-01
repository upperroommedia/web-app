/**
 * Sermon Details Page
 * - View full sermon metadata
 * - Play controls
 * - Series information
 * - Inline publishing status (no popup)
 * - Edit and Delete actions
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import ListItem from '@mui/material/ListItem';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import CloudIcon from '@mui/icons-material/Cloud';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import PendingIcon from '@mui/icons-material/Pending';
import CollectionsIcon from '@mui/icons-material/Collections';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import UploadIcon from '@mui/icons-material/Upload';
import AddIcon from '@mui/icons-material/Add';
import Link from 'next/link';
import { alpha, useTheme } from '@mui/material/styles';

import AppLayout from '../../../layout/AppLayout';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import firestore, { doc, getDoc, getDocs, deleteDoc, collection, writeBatch, deleteField, updateDoc, setDoc, query, orderBy, where, limit, serverTimestamp } from '../../../firebase/firestore';
import storage, { getDownloadURL, ref } from '../../../firebase/storage';
import { sermonStatusType, uploadStatus } from '../../../types/SermonTypes';
import { sermonConverter } from '../../../types/Sermon';
import { Series, seriesConverter } from '../../../types/Series';
import { SermonList, sermonListConverter } from '../../../types/SermonList';
import useAuth from '../../../context/user/UserContext';
import useAudioPlayer from '../../../context/audio/audioPlayerContext';
import { useMediaState, useMediaRemote } from '@vidstack/react';
import { createFunctionV2 } from '../../../utils/createFunction';
import { DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType } from '../../../functions/src/deleteFromSubsplash';
import { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../../../functions/src/uploadToSoundCloud';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../../../functions/src/uploadToSubsplash';
import { AddtoListInputType, AddToListOutputType } from '../../../functions/src/addToList';
import { RemoveFromListInputType, RemoveFromListOutputType } from '../../../functions/src/removeFromList';
import { CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType } from '../../../functions/src/createNewSubsplashList';
import { AddToSeriesInputType, AddToSeriesOutputType } from '../../../functions/src/addToSeries';
import { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '../../../functions/src/removeFromSeries';
import { CreateSeriesInputType, CreateSeriesOutputType } from '../../../functions/src/createSeries';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../../../functions/src/reorderSeriesItems';
import UserAvatar from '../../../components/UserAvatar';
import { User } from '../../../types/User';
import { GetUserInputType, GetUserOutputType } from '../../../functions/src/getUser';
import { getSquareImageStoragePath } from '../../../utils/utils';
import { isDevelopment } from '../../../firebase/firebase';
import { useCollectionData, useDocument } from 'react-firebase-hooks/firestore';
import { useObject } from 'react-firebase-hooks/database';
import database, { ref as dbRef } from '../../../firebase/database';
import UploadStatusList from '../../../components/UploadStatusList';
import LinearProgress from '@mui/material/LinearProgress';

const SermonDetailsPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const sermonId = router.query.sermonId as string;
  const { currentSermon, setCurrentSermon } = useAudioPlayer();
  const remote = useMediaRemote();
  const playing = useMediaState('playing');
  const pageContainerSx = { maxWidth: 1400, mx: 'auto', width: '100%', px: { xs: 0.5, sm: 2, md: 3 } };

  const [series, setSeries] = useState<Series | null>(null);
  const [uploader, setUploader] = useState<User | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [deletePopup, setDeletePopup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Publishing state
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState(false);
  const [_isUploadingToSubsplash, setIsUploadingToSubsplash] = useState(false);
  const [seriesPublishAction, setSeriesPublishAction] = useState<'publish' | 'unpublish' | null>(null);
  const [confirmSeriesUnpublishOpen, setConfirmSeriesUnpublishOpen] = useState(false);
  const [addToSeriesDialogOpen, setAddToSeriesDialogOpen] = useState(false);
  const [ownedSeriesOptions, setOwnedSeriesOptions] = useState<Series[]>([]);
  const [loadingOwnedSeries, setLoadingOwnedSeries] = useState(false);
  const [selectedOwnedSeriesId, setSelectedOwnedSeriesId] = useState('');
  const [ownedSeriesSearchQuery, setOwnedSeriesSearchQuery] = useState('');
  const [isAddingToSeries, setIsAddingToSeries] = useState(false);

  // Real-time sermon document listener
  const [sermonSnapshot, sermonLoading, sermonError] = useDocument(
    sermonId ? doc(firestore, 'sermons', sermonId).withConverter(sermonConverter) : null,
    {
      snapshotListenOptions: { includeMetadataChanges: true },
    }
  );
  const sermon = sermonSnapshot?.data();
  const [seriesItemSnapshot] = useDocument(
    sermon?.seriesId ? doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id) : null
  );

  // Sermon lists
  const [sermonLists, listsLoading, _listsError] = useCollectionData(
    sermonId ? collection(firestore, `sermons/${sermonId}/sermonLists`).withConverter(sermonListConverter) : null
  );

  // Real-time processing progress from Firebase Realtime Database
  const [progressSnapshot] = useObject(sermonId ? dbRef(database, `addIntroOutro/${sermonId}`) : null);
  const processingProgress = progressSnapshot?.val() ? Number(progressSnapshot.val()) : 0;

  const isAdmin = user?.isAdmin() ?? false;
  const canPublish = user?.canPublish() ?? false;
  const isCurrentlyPlaying = currentSermon?.id === sermonId && playing;
  const isSoundCloudUploaded = sermon?.status.soundCloud === uploadStatus.UPLOADED;

  const listItemsUploaded = sermonLists?.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED) || [];
  const listItemsNotUploaded = sermonLists?.filter((list) => list.uploadStatus?.status !== uploadStatus.UPLOADED) || [];
  const seriesPublishedToSubsplash = seriesItemSnapshot?.exists() && seriesItemSnapshot.data()?.publishedToSubsplash === true;
  const refreshSeriesState = useCallback(async (seriesId: string) => {
    const latestSeriesSnapshot = await getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter));
    if (latestSeriesSnapshot.exists()) {
      setSeries(latestSeriesSnapshot.data());
    }
  }, []);

  // Fetch series and uploader when relevant ids change (narrow deps to avoid refetch on every sermon snapshot)
  useEffect(() => {
    if (!sermon) return;

    if (!isAdmin && !canPublish && sermon.uploaderId !== user?.uid) {
      setError('You do not have permission to view this sermon');
      return;
    }
    setError(null);

    if (sermon.seriesId) {
      getDoc(doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter))
        .then((seriesDoc) => {
          if (seriesDoc.exists()) {
            setSeries(seriesDoc.data());
          }
        })
        .catch((err) => {
          console.error('Error fetching series:', err);
        });
    } else {
      setSeries(null);
    }

    if (sermon.uploaderId) {
      const getUser = createFunctionV2<GetUserInputType, GetUserOutputType>('getuser');
      getUser({ uid: sermon.uploaderId })
        .then((result) => {
          if (result.status === 'success') {
            setUploader(result.data);
          }
        })
        .catch((err) => {
          console.error('Error fetching uploader:', err);
        });
    } else {
      setUploader(undefined);
    }
    // Intentionally depend on ids only to avoid refetch on every sermon snapshot (e.g. metadata-only updates)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sermon read for permission/seriesId/uploaderId; ids are sufficient
  }, [sermon?.id, sermon?.seriesId, sermon?.uploaderId, isAdmin, canPublish, user?.uid]);

  // Handle errors from real-time listener
  useEffect(() => {
    if (sermonError) {
      console.error('Error fetching sermon:', sermonError);
      setError(sermonError.message || 'Failed to fetch sermon');
    }
  }, [sermonError]);

  // Check if sermon exists
  useEffect(() => {
    if (!sermonLoading && sermonId && sermonSnapshot && !sermonSnapshot.exists()) {
      setError('Sermon not found');
    }
  }, [sermonLoading, sermonId, sermonSnapshot]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!sermon) return;

    setIsDeleting(true);
    try {
      const promises: Promise<any>[] = [];

      if (sermon.subsplashId) {
        const deleteFromSubsplash = createFunctionV2<DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType>('deletefromsubsplash');
        promises.push(deleteFromSubsplash({ subsplashId: sermon.subsplashId }));
      }

      if (sermon.soundCloudTrackId) {
        const deleteFromSoundCloud = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
        promises.push(deleteFromSoundCloud({ soundCloudTrackId: sermon.soundCloudTrackId }));
      }

      await Promise.allSettled(promises);
      await deleteDoc(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter));

      if (currentSermon?.id === sermon.id) {
        setCurrentSermon(undefined);
      }

      router.push('/admin/sermons');
    } catch (err: any) {
      console.error('Error deleting sermon:', err);
      alert(err.message || 'Failed to delete sermon');
    }
    setIsDeleting(false);
  }, [sermon, currentSermon, setCurrentSermon, router]);

  // SoundCloud upload/delete
  const uploadToSoundCloud = useCallback(async () => {
    if (!sermon) return;
    setIsUploadingToSoundCloud(true);

    const uploadToSoundCloudFn = createFunctionV2<UploadToSoundCloudInputType, UploadToSoundCloudReturnType>('uploadtosoundcloud');
    const data: UploadToSoundCloudInputType = {
      title: sermon.title,
      description: sermon.description,
      tags: [sermon.subtitle, ...sermon.topics],
      speakers: sermon.speakers.map((speaker) => speaker.name),
      audioStoragePath: `intro-outro-sermons/${sermon.id}`,
      imageStoragePath: getSquareImageStoragePath(sermon),
    };

    try {
      const result = await uploadToSoundCloudFn(data);
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      await updateDoc(sermonRef, {
        soundCloudTrackId: result.soundCloudTrackId,
        status: { ...sermon.status, soundCloud: uploadStatus.UPLOADED },
      });
    } catch (error: any) {
      console.error('Error uploading to SoundCloud:', error);
      alert(error.message || 'Failed to upload to SoundCloud');
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [sermon]);

  const deleteFromSoundCloud = useCallback(async () => {
    if (!sermon) return;
    setIsUploadingToSoundCloud(true);

    const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);

    if (!sermon.soundCloudTrackId) {
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
      setIsUploadingToSoundCloud(false);
      return;
    }

    const deleteFromSoundCloudFn = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');

    try {
      await deleteFromSoundCloudFn({ soundCloudTrackId: sermon.soundCloudTrackId });
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
    } catch (error: any) {
      if (error.details?.includes('Invalid track id')) {
        await updateDoc(sermonRef, {
          soundCloudTrackId: deleteField(),
          status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
        });
      } else {
        console.error('Error deleting from SoundCloud:', error);
        alert(error.message || 'Failed to remove from SoundCloud');
      }
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [sermon]);

  // Subsplash functions
  const uploadToSubsplash = async (listsToUploadTo: SermonList[]): Promise<string | undefined> => {
    if (!sermon) return undefined;
    try {
      const subsplashIdToListIdMap = new Map<string, string>();
      const uploadToSubsplashCallable = createFunctionV2<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
      const addToList = createFunctionV2<AddtoListInputType, AddToListOutputType>('addtolist');
      const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.id}`));

      const data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
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

      setIsUploadingToSubsplash(true);

      let id = sermon.subsplashId;
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      if (!id) {
        const response = (await uploadToSubsplashCallable(data)) as unknown as { id: string };
        id = response.id;
        await updateDoc(sermonRef, { subsplashId: id });
      }

      const listsMetadata = await Promise.all(
        listsToUploadTo.map(async (list) => {
          if (list.subsplashId) {
            subsplashIdToListIdMap.set(list.subsplashId, list.id);
            return { listId: list.subsplashId, overflowBehavior: list.overflowBehavior, type: list.type };
          }
          const createNewSubsplashList = createFunctionV2<CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType>('createnewsubsplashlist');
          const { listId } = await createNewSubsplashList({ title: list.name, subtitle: '', images: list.images });
          await updateDoc(doc(firestore, `lists/${list.id}`), { subsplashId: listId });
          subsplashIdToListIdMap.set(listId, list.id);
          return { listId, overflowBehavior: list.overflowBehavior, type: list.type };
        })
      );

      const addToListReturn = await addToList({
        destinationListIds: listsMetadata.map(m => m.listId),
        mediaItem: { id, type: 'media-item' },
      });

      const batch = writeBatch(firestore);
      addToListReturn.forEach((r) => {
        const listId = subsplashIdToListIdMap.get(r.listId);
        if (!listId) return;
        const docRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${listId}`).withConverter(sermonListConverter);
        if (r.status === 'success') {
          batch.update(docRef, { uploadStatus: { status: uploadStatus.UPLOADED, listItemId: r.listItemId } });
        } else {
          batch.update(docRef, { uploadStatus: { status: uploadStatus.ERROR, reason: r.error } });
        }
      });
      batch.update(sermonRef, { status: { ...sermon.status, subsplash: uploadStatus.UPLOADED }, approverId: user?.uid });
      await batch.commit();
      return id;
    } catch (error) {
      console.error('Error uploading to Subsplash:', error);
      alert(error);
      return undefined;
    } finally {
      setIsUploadingToSubsplash(false);
    }
  };

  const removeFromList = async (listsToRemoveFrom: SermonList[]) => {
    if (!sermon) return;
    try {
      const removeFromListCallable = createFunctionV2<RemoveFromListInputType, RemoveFromListOutputType>('removefromlist');
      const listsToRemoveFiltered = listsToRemoveFrom.filter(
        (list) => list.uploadStatus?.status === uploadStatus.UPLOADED && list.uploadStatus.listItemId
      );

      const subsplashIdToFirestoreIdMap = new Map<string, string>();
      listsToRemoveFiltered.forEach((list) => {
        if (list.subsplashId) subsplashIdToFirestoreIdMap.set(list.subsplashId, list.id);
      });

      const removeFromListReturn = await removeFromListCallable({
        listIds: listsToRemoveFiltered.map((list) => list.subsplashId) as string[],
        listItemIds: listsToRemoveFiltered.map((list) => list.uploadStatus?.status === uploadStatus.UPLOADED ? list.uploadStatus.listItemId : '') as string[],
        itemIds: listsToRemoveFiltered.map(() => sermon.subsplashId || sermon.id) as string[],
        itemTypes: listsToRemoveFiltered.map(() => 'media-item') as string[],
      });

      const batch = writeBatch(firestore);
      for (const r of removeFromListReturn) {
        if (r.status === 'error') continue;
        const firestoreListId = subsplashIdToFirestoreIdMap.get(r.listId);
        if (!firestoreListId) continue;
        const docRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${firestoreListId}`).withConverter(sermonListConverter);
        const docSnapshot = await getDoc(docRef);
        if (!docSnapshot.exists()) continue;
        batch.update(docRef, { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
      }
      await batch.commit();
    } catch (error) {
      console.error('Error removing from list:', error);
      alert(error);
    }
  };

  const deleteFromSubsplash = useCallback(async () => {
    if (!sermon) return;
    const deleteFromSubsplashCall = createFunctionV2<{ subsplashId: string }, void>('deletefromsubsplash');
    try {
      setIsUploadingToSubsplash(true);
      if (sermon.subsplashId) {
        await deleteFromSubsplashCall({ subsplashId: sermon.subsplashId });
      }

      const batch = writeBatch(firestore);
      const sermonSeriesList = collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter);
      const sermonSeriesListSnapshot = await getDocs(sermonSeriesList);
      sermonSeriesListSnapshot.forEach((docSnap) => {
        batch.update(docSnap.ref, { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
      });
      if (sermon.seriesId) {
        const seriesItemRef = doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id);
        const seriesItemSnapshot = await getDoc(seriesItemRef);
        if (seriesItemSnapshot.exists()) {
          batch.update(seriesItemRef, {
            publishedToSubsplash: false,
            sermonSubsplashId: deleteField(),
          });
        }
      }
      batch.update(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter), {
        subsplashId: deleteField(),
        status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
      });
      await batch.commit();
    } catch (error: any) {
      if (error.code === 'functions/not-found') {
        const batch = writeBatch(firestore);
        if (sermon.seriesId) {
          const seriesItemRef = doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id);
          const seriesItemSnapshot = await getDoc(seriesItemRef);
          if (seriesItemSnapshot.exists()) {
            batch.update(seriesItemRef, {
              publishedToSubsplash: false,
              sermonSubsplashId: deleteField(),
            });
          }
        }
        batch.update(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter), {
          subsplashId: deleteField(),
          status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
        });
        await batch.commit();
      } else {
        console.error('Error deleting from Subsplash:', error);
        alert(error.message || 'Failed to delete from Subsplash');
      }
    } finally {
      setIsUploadingToSubsplash(false);
    }
  }, [sermon]);

  const publishToSeriesForSeries = useCallback(async (targetSeries: Series) => {
    if (!sermon) {
      throw new Error('Sermon not found.');
    }

    let mediaItemId = sermon.subsplashId;
    if (!mediaItemId) {
      mediaItemId = await uploadToSubsplash([]);
    }

    if (!mediaItemId) {
      throw new Error('Sermon must be uploaded to Subsplash before publishing to series.');
    }

    let resolvedSeries = targetSeries;
    let seriesSubsplashId = targetSeries.subsplashId;
    if (!seriesSubsplashId) {
      const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
      const createResult = await createSeriesFunction({
        title: targetSeries.name,
        summary: targetSeries.summary,
        ownerId: targetSeries.ownerId,
        skipSubsplash: false,
      });

      if (createResult.status !== 'success' || !createResult.subsplashId) {
        throw new Error(createResult.error || 'Failed to create series in Subsplash.');
      }

      seriesSubsplashId = createResult.subsplashId;
      await updateDoc(doc(firestore, 'series', targetSeries.id), {
        subsplashId: seriesSubsplashId,
        status: 'published',
      });
      resolvedSeries = { ...targetSeries, subsplashId: seriesSubsplashId, status: 'published' };
      setSeries((previousSeries) => (
        previousSeries && previousSeries.id === targetSeries.id ? resolvedSeries : previousSeries
      ));
    }

    const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
    const addResult = await addToSeriesFunction({
      seriesSubsplashId,
      mediaItemId,
    });
    if (!addResult || addResult.status !== 'success') {
      throw new Error(addResult?.error || 'Failed to add sermon to series.');
    }
    const confirmedMediaItemId = addResult.mediaItemId || mediaItemId;

    const orderedItemsSnapshot = await getDocs(
      query(collection(firestore, `series/${resolvedSeries.id}/seriesItems`), orderBy('position', 'desc'))
    );
    const targetExistsInOrder = orderedItemsSnapshot.docs.some((seriesItemDoc) => seriesItemDoc.id === sermon.id);
    if (!targetExistsInOrder) {
      throw new Error('Sermon is missing from Firestore series order. Refresh and retry.');
    }

    const publishedItems = orderedItemsSnapshot.docs
      .map((seriesItemDoc) => {
        const data = seriesItemDoc.data() as { publishedToSubsplash?: boolean; sermonSubsplashId?: string };
        const isPublished = seriesItemDoc.id === sermon.id ? true : data.publishedToSubsplash === true;
        const itemMediaItemId = seriesItemDoc.id === sermon.id
          ? confirmedMediaItemId
          : data.sermonSubsplashId;
        return {
          sermonId: seriesItemDoc.id,
          isPublished,
          mediaItemId: itemMediaItemId,
        };
      })
      .filter((item) => item.isPublished);

    const missingMediaId = publishedItems.find((item) => !item.mediaItemId);
    if (missingMediaId) {
      throw new Error(`Published series item ${missingMediaId.sermonId} is missing a Subsplash media ID.`);
    }

    const reorderSeriesFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>('reorderseriesitems');
    const reorderResult = await reorderSeriesFunction({
      firestoreSeriesId: resolvedSeries.id,
      itemOrder: publishedItems.map((item, index) => ({
        mediaItemId: item.mediaItemId as string,
        // Subsplash uses inverted ordering semantics: position 1 is the bottom item.
        position: publishedItems.length - index,
      })),
    });
    if (reorderResult.status !== 'success') {
      const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
      await removeFromSeriesFunction({ mediaItemId: confirmedMediaItemId });
      throw new Error(reorderResult.message || 'Subsplash reorder failed.');
    }

    await setDoc(
      doc(firestore, `series/${resolvedSeries.id}/seriesItems`, sermon.id),
      {
        publishedToSubsplash: true,
        sermonSubsplashId: confirmedMediaItemId,
      },
      { merge: true }
    );
    await refreshSeriesState(resolvedSeries.id);
  }, [refreshSeriesState, sermon, uploadToSubsplash]);

  const publishToSeries = useCallback(async () => {
    if (!series) {
      return;
    }

    setSeriesPublishAction('publish');
    try {
      await publishToSeriesForSeries(series);
    } catch (err: any) {
      console.error('Error publishing sermon to series:', err);
      alert(err?.message || 'Failed to publish sermon to series');
    } finally {
      setSeriesPublishAction(null);
    }
  }, [publishToSeriesForSeries, series]);

  const openAddToSeriesDialog = useCallback(async () => {
    if (!user?.uid) {
      return;
    }

    setAddToSeriesDialogOpen(true);
    setLoadingOwnedSeries(true);
    setOwnedSeriesOptions([]);
    setSelectedOwnedSeriesId('');
    setOwnedSeriesSearchQuery('');
    try {
      const ownedSeriesSnapshot = await getDocs(
        query(
          collection(firestore, 'series').withConverter(seriesConverter),
          where('ownerId', '==', user.uid),
          limit(100)
        )
      );
      const ownedSeries = ownedSeriesSnapshot.docs
        .map((seriesDoc) => seriesDoc.data())
        .sort((a, b) => a.name.localeCompare(b.name));
      setOwnedSeriesOptions(ownedSeries);
      if (ownedSeries.length === 1) {
        setSelectedOwnedSeriesId(ownedSeries[0].id);
      }
    } catch (err: any) {
      console.error('Error loading owned series:', err);
      alert(err?.message || 'Failed to load your series');
    } finally {
      setLoadingOwnedSeries(false);
    }
  }, [user?.uid]);

  const addSermonToSelectedSeries = useCallback(async () => {
    if (!sermon || !user?.uid || !selectedOwnedSeriesId || isAddingToSeries) {
      return;
    }

    setIsAddingToSeries(true);
    try {
      const selectedSeriesRef = doc(firestore, 'series', selectedOwnedSeriesId).withConverter(seriesConverter);
      const selectedSeriesSnapshot = await getDoc(selectedSeriesRef);
      if (!selectedSeriesSnapshot.exists()) {
        throw new Error('Selected series no longer exists.');
      }

      const selectedSeries = selectedSeriesSnapshot.data();
      if (selectedSeries.ownerId !== user.uid) {
        throw new Error('You can only add sermons to series you own.');
      }
      if (sermon.seriesId && sermon.seriesId !== selectedSeries.id) {
        throw new Error('This sermon is already assigned to another series.');
      }

      const latestPositionSnapshot = await getDocs(
        query(
          collection(firestore, `series/${selectedSeries.id}/seriesItems`),
          orderBy('position', 'desc'),
          limit(1)
        )
      );
      const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
      const nextPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;

      await setDoc(
        doc(firestore, `series/${selectedSeries.id}/seriesItems`, sermon.id),
        {
          id: sermon.id,
          position: nextPosition,
          publishedToSubsplash: false,
          ...(sermon.subsplashId ? { sermonSubsplashId: sermon.subsplashId } : {}),
          addedAt: serverTimestamp(),
        }
      );
      await updateDoc(doc(firestore, 'sermons', sermon.id), { seriesId: selectedSeries.id });

      if (sermon.subsplashId || sermon.status.subsplash === uploadStatus.UPLOADED) {
        setSeriesPublishAction('publish');
        try {
          await publishToSeriesForSeries(selectedSeries);
        } catch (publishErr: any) {
          await deleteDoc(doc(firestore, `series/${selectedSeries.id}/seriesItems`, sermon.id));
          await updateDoc(doc(firestore, 'sermons', sermon.id), { seriesId: null });
          throw new Error(
            publishErr?.message || 'Automatic series publish failed. Sermon was not added to series.'
          );
        } finally {
          setSeriesPublishAction(null);
        }
      }

      await refreshSeriesState(selectedSeries.id);
      setAddToSeriesDialogOpen(false);
      setSelectedOwnedSeriesId('');
      setOwnedSeriesSearchQuery('');
    } catch (err: any) {
      console.error('Error adding sermon to selected series:', err);
      alert(err?.message || 'Failed to add sermon to series');
    } finally {
      setIsAddingToSeries(false);
    }
  }, [isAddingToSeries, publishToSeriesForSeries, refreshSeriesState, selectedOwnedSeriesId, sermon, user?.uid]);

  const unpublishFromSeries = useCallback(async () => {
    if (!sermon || !series) {
      return;
    }

    setSeriesPublishAction('unpublish');
    try {
      const seriesItemData = seriesItemSnapshot?.data() as { sermonSubsplashId?: string } | undefined;
      const mediaItemId = seriesItemData?.sermonSubsplashId || sermon.subsplashId;

      if (mediaItemId) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        await removeFromSeriesFunction({ mediaItemId });
      }

      await setDoc(
        doc(firestore, `series/${series.id}/seriesItems`, sermon.id),
        {
          publishedToSubsplash: false,
          sermonSubsplashId: deleteField(),
        },
        { merge: true }
      );
      await refreshSeriesState(series.id);
      setConfirmSeriesUnpublishOpen(false);
    } catch (err: any) {
      console.error('Error unpublishing sermon from series:', err);
      alert(err?.message || 'Failed to unpublish sermon from series');
    } finally {
      setSeriesPublishAction(null);
    }
  }, [refreshSeriesState, series, seriesItemSnapshot, sermon]);

  // Play/pause toggle
  const handlePlayPause = () => {
    if (!sermon) return;
    if (currentSermon?.id !== sermon.id) {
      setCurrentSermon(sermon);
    } else {
      remote.togglePaused();
    }
  };

  // Format duration to nearest second
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get status chip info
  const getStatusInfo = () => {
    if (!sermon) return null;
    const status = sermon.status.audioStatus;
    if (status === sermonStatusType.PROCESSED) {
      return { color: 'success' as const, icon: <CheckCircleIcon fontSize="small" />, label: 'Processed' };
    }
    if (status === sermonStatusType.PROCESSING) {
      return { color: 'warning' as const, icon: <PendingIcon fontSize="small" />, label: 'Processing' };
    }
    if (status === sermonStatusType.ERROR) {
      return { color: 'error' as const, icon: <ErrorIcon fontSize="small" />, label: 'Error' };
    }
    return { color: 'default' as const, icon: <PendingIcon fontSize="small" />, label: status };
  };

  const statusInfo = getStatusInfo();
  const selectedOwnedSeries = ownedSeriesOptions.find((candidate) => candidate.id === selectedOwnedSeriesId) || null;
  const uploaderName = uploader
    ? (`${uploader.firstName ?? ''} ${uploader.lastName ?? ''}`.trim() || uploader.displayName || uploader.email)
    : 'Unknown';
  const derivedSeriesSubtitle = series ? `${series.publishedItemCount || 0} part series` : null;

  // Check if user can edit/delete
  const canEdit = sermon && (
    canPublish ||
    (user?.canUpload() && sermon.status.subsplash !== uploadStatus.UPLOADED && sermon.status.soundCloud !== uploadStatus.UPLOADED)
  );

  const canDelete = sermon && (
    canPublish ||
    (user?.canUpload() && sermon.status.subsplash !== uploadStatus.UPLOADED && sermon.status.soundCloud !== uploadStatus.UPLOADED && sermon.status.audioStatus !== sermonStatusType.PENDING)
  );

  if (sermonLoading) {
    return (
      <Box sx={{ ...pageContainerSx, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !sermon) {
    return (
      <Box sx={{ ...pageContainerSx, py: 2 }}>
        <Alert severity="error">{error || 'Sermon not found'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push('/admin/sermons')}
          sx={{ mt: 2 }}
        >
          Back to Sermons
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Head>
        <title>{sermon.title} | Admin | Upper Room Media</title>
      </Head>

      <Box sx={pageContainerSx}>
        {/* Breadcrumbs */}
        <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} sx={{ mb: { xs: 1, sm: 2 } }}>
          <Link href="/admin/sermons" style={{ textDecoration: 'none' }}>
            <Typography sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' }, fontSize: { xs: '0.8rem', sm: '1rem' } }}>
              Sermons
            </Typography>
          </Link>
          <Typography color="text.primary" fontWeight={500} noWrap sx={{ maxWidth: { xs: 200, sm: 'none' }, fontSize: { xs: '0.8rem', sm: '1rem' } }}>
            {sermon.title}
          </Typography>
        </Breadcrumbs>

        {/* Main Card */}
        <Card sx={{ overflow: 'visible' }}>
          <CardContent sx={{ p: { xs: 1.5, sm: 2, md: 3 } }}>
            {/* Header with Image and Info - Image always on right */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'row',
                gap: { xs: 1.5, sm: 2, md: 3 },
                mb: { xs: 2, sm: 3 },
              }}
            >
              {/* Info Section - First so it's on the left */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="h4"
                  fontWeight={700}
                  gutterBottom
                  sx={{
                    fontSize: { xs: '1.25rem', sm: '1.5rem', md: '2rem' },
                  }}
                >
                  {sermon.title}
                </Typography>

                {sermon.subtitle && (
                  <Typography variant="h6" color="text.secondary" gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem', md: '1.25rem' } }}>
                    {sermon.subtitle}
                  </Typography>
                )}

                {/* Speakers */}
                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: { xs: 1, sm: 2 } }}>
                  {sermon.speakers.map((speaker) => (
                    <Chip key={speaker.id} label={speaker.name} size="small" variant="outlined" sx={{ height: { xs: 22, sm: 26 }, '& .MuiChip-label': { fontSize: { xs: '0.7rem', sm: '0.8rem' } } }} />
                  ))}
                </Stack>

                {/* Meta Info - Dates */}
                <Stack spacing={0.5} sx={{ mb: { xs: 1, sm: 2 } }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <CalendarTodayIcon sx={{ fontSize: { xs: 14, sm: 18 }, color: 'text.secondary' }} />
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                      <strong>Date:</strong> {new Date(sermon.dateMillis).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <UploadIcon sx={{ fontSize: { xs: 14, sm: 18 }, color: 'text.secondary' }} />
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                      <strong>Uploaded:</strong> {new Date(sermon.createdAtMillis).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                    </Typography>
                  </Stack>
                  {sermon.durationSeconds > 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                      <strong>Duration:</strong> {formatDuration(sermon.durationSeconds)}
                    </Typography>
                  )}
                </Stack>

                {/* Status chip */}
                {statusInfo && sermon.status.audioStatus !== sermonStatusType.PROCESSED && (
                  <Box sx={{ mb: 2 }}>
                    <Chip
                      icon={statusInfo.icon}
                      label={sermon.status.audioStatus === sermonStatusType.PROCESSING && processingProgress > 0
                        ? `${statusInfo.label} (${processingProgress}%)`
                        : statusInfo.label}
                      size="small"
                      color={statusInfo.color}
                      variant="outlined"
                    />
                    {sermon.status.audioStatus === sermonStatusType.PROCESSING && processingProgress > 0 && (
                      <LinearProgress
                        variant="determinate"
                        value={processingProgress}
                        sx={{
                          mt: 1,
                          height: 6,
                          borderRadius: 3,
                          maxWidth: 200,
                          bgcolor: alpha(theme.palette.warning.main, 0.15),
                          '& .MuiLinearProgress-bar': {
                            bgcolor: 'warning.main',
                            borderRadius: 3,
                          }
                        }}
                      />
                    )}
                  </Box>
                )}

                {/* Play Button */}
                {sermon.status.audioStatus === sermonStatusType.PROCESSED && (
                  <Button
                    variant="contained"
                    size="large"
                    startIcon={isCurrentlyPlaying ? <PauseCircleIcon /> : <PlayCircleIcon />}
                    onClick={handlePlayPause}
                    sx={{ mb: 2 }}
                  >
                    {isCurrentlyPlaying ? 'Pause' : 'Play'}
                  </Button>
                )}

                {/* Uploader Info */}
                <Stack direction="row" spacing={1} alignItems="center">
                  <UserAvatar user={uploader} sx={{ width: { xs: 20, sm: 40 }, height: { xs: 20, sm: 40 } }} />
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                    Uploaded by {uploaderName}
                  </Typography>
                </Stack>
              </Box>

              {/* Cover Image - On the right */}
              <Box sx={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: { xs: 80, sm: 120, md: 160 },
                    height: { xs: 80, sm: 120, md: 160 },
                    borderRadius: { xs: 1, sm: 2 },
                    overflow: 'hidden',
                    boxShadow: 2,
                    bgcolor: sermon.images?.find((img) => img.type === 'square')?.averageColorHex || 'action.hover',
                    backgroundImage: sermon.images?.find((img) => img.type === 'square')?.downloadLink
                      ? `url(${sermon.images.find((img) => img.type === 'square')?.downloadLink})`
                      : 'url(/URM_Icon.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                />
                {/* Action Buttons below image */}
                <Stack spacing={0.5} sx={{ width: '100%' }}>
                  {canEdit && (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<EditIcon />}
                      onClick={() => router.push(`/admin/sermons/${sermonId}/edit`)}
                      sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem' } }}
                    >
                      Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      startIcon={<DeleteIcon />}
                      onClick={() => setDeletePopup(true)}
                      sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem' } }}
                    >
                      Delete
                    </Button>
                  )}
                </Stack>
              </Box>
            </Box>

            <Divider sx={{ my: 3 }} />

            {/* Description */}
            <Box sx={{ mb: { xs: 2, sm: 3 } }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                Description
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', fontSize: { xs: '0.8rem', sm: '0.9rem' } }}>
                {sermon.description || 'No description provided.'}
              </Typography>
            </Box>

            {/* Topics */}
            {sermon.topics && sermon.topics.length > 0 && (
              <Box sx={{ mb: { xs: 2, sm: 3 } }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                  Topics
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {sermon.topics.map((topic) => (
                    <Chip key={topic} label={topic} size="small" variant="outlined" sx={{ height: { xs: 22, sm: 26 }, '& .MuiChip-label': { fontSize: { xs: '0.7rem', sm: '0.8rem' } } }} />
                  ))}
                </Stack>
              </Box>
            )}

            {/* Series Info */}
            {series && (
              <>
                <Divider sx={{ my: { xs: 2, sm: 3 } }} />
                <Box sx={{ mb: { xs: 2, sm: 3 } }}>
                  <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                    Series
                  </Typography>
                  <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
                    <Card
                      variant="outlined"
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: { xs: 1, sm: 2 },
                        p: { xs: 1, sm: 2 },
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        '&:hover': { borderColor: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.04) },
                      }}
                    >
                      <AvatarWithDefaultImage
                        width={50}
                        height={50}
                        altName={series.name}
                        borderRadius={6}
                        image={series.images?.find((img) => img.type === 'square')}
                      />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" fontWeight={600} sx={{ fontSize: { xs: '0.85rem', sm: '1rem' } }}>
                          {series.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.75rem', sm: '0.85rem' } }}>
                          {derivedSeriesSubtitle}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.75rem' } }}>
                          {series.itemCount} items
                        </Typography>
                      </Box>
                    </Card>
                  </Link>
                </Box>
              </>
            )}

            {/* Publishing Status - Inline */}
            {canPublish && sermon.status.audioStatus === sermonStatusType.PROCESSED && (
              <>
                <Divider sx={{ my: { xs: 2, sm: 3 } }} />
                <Box>
                  <Typography variant="subtitle1" fontWeight={600} gutterBottom>
                    Publishing Status
                  </Typography>

                  {/* SoundCloud */}
                  <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={2} alignItems="center">
                        <CloudIcon sx={{ fontSize: 28, color: isSoundCloudUploaded ? 'success.main' : 'text.disabled' }} />
                        <Box>
                          <Typography variant="subtitle2">SoundCloud</Typography>
                          <Typography variant="body2" color="text.secondary">
                            {isSoundCloudUploaded ? 'Published' : 'Not Published'}
                          </Typography>
                        </Box>
                      </Stack>
                      {isUploadingToSoundCloud ? (
                        <CircularProgress size={24} />
                      ) : isSoundCloudUploaded ? (
                        <Button variant="outlined" color="error" size="small" startIcon={<CloudOffIcon />} onClick={deleteFromSoundCloud}>
                          Remove
                        </Button>
                      ) : (
                        <Button variant="contained" size="small" startIcon={<CloudUploadIcon />} onClick={uploadToSoundCloud} disabled={isDevelopment}>
                          {isDevelopment ? 'Dev Mode' : 'Upload'}
                        </Button>
                      )}
                    </Stack>
                  </Card>

                  {/* Subsplash Lists */}
                  <Card variant="outlined" sx={{ p: 2 }}>
                    <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
                      <CollectionsIcon sx={{ fontSize: 28, color: listItemsUploaded.length > 0 ? 'success.main' : 'text.disabled' }} />
                      <Box>
                        <Typography variant="subtitle2">Subsplash Lists</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {listItemsUploaded.length} / {sermonLists?.length || 0} lists published
                        </Typography>
                      </Box>
                    </Stack>

                    {listsLoading ? (
                      <CircularProgress size={20} />
                    ) : (
                      <Stack spacing={2}>
                        <UploadStatusList
                          key={listItemsUploaded.map((list) => list.id).join('') + 'Uploaded'}
                          sectionTitle="Published"
                          sermonListItems={listItemsUploaded}
                          buttonAction={removeFromList}
                          allSelectedButtonAction={deleteFromSubsplash}
                          buttonLabel="Remove From Lists"
                          buttonColorVariant="error"
                        />
                        <UploadStatusList
                          key={listItemsNotUploaded.map((list) => list.id).join('') + 'NotUploaded'}
                          sectionTitle="Not Published"
                          sermonListItems={listItemsNotUploaded}
                          buttonAction={async (lists) => { await uploadToSubsplash(lists); }}
                          buttonLabel="Publish to Subsplash"
                        />
                      </Stack>
                    )}
                  </Card>

                  {/* Subsplash Series */}
                  <Card variant="outlined" sx={{ p: 2, mt: 2 }}>
                    <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
                      <Stack direction="row" spacing={2} alignItems="center">
                        <CollectionsIcon sx={{ fontSize: 28, color: seriesPublishedToSubsplash ? 'success.main' : 'text.disabled' }} />
                        <Box>
                          <Typography variant="subtitle2">Subsplash Series</Typography>
                          {series ? (
                            <Typography variant="body2" color="text.secondary">
                              {series.name} • {seriesPublishedToSubsplash ? 'Published' : 'Not Published'}
                            </Typography>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              No series assigned
                            </Typography>
                          )}
                        </Box>
                      </Stack>

                      {!series ? (
                        <Button
                          variant="contained"
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={openAddToSeriesDialog}
                          disabled={loadingOwnedSeries || isAddingToSeries}
                        >
                          Add To Series
                        </Button>
                      ) : seriesPublishAction ? (
                        <CircularProgress size={22} />
                      ) : seriesPublishedToSubsplash ? (
                        <Button
                          variant="outlined"
                          color="warning"
                          size="small"
                          startIcon={<CloudOffIcon />}
                          onClick={() => setConfirmSeriesUnpublishOpen(true)}
                        >
                          Unpublish
                        </Button>
                      ) : (
                        <Button
                          variant="contained"
                          size="small"
                          startIcon={<CloudUploadIcon />}
                          onClick={publishToSeries}
                        >
                          Publish
                        </Button>
                      )}
                    </Stack>
                  </Card>
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      </Box>

      <Dialog
        open={confirmSeriesUnpublishOpen}
        onClose={() => !seriesPublishAction && setConfirmSeriesUnpublishOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Unpublish From Series?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This will remove this sermon from the Subsplash series, but keep it assigned to the series in this app.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setConfirmSeriesUnpublishOpen(false)}
            disabled={Boolean(seriesPublishAction)}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={unpublishFromSeries}
            disabled={Boolean(seriesPublishAction)}
            startIcon={seriesPublishAction === 'unpublish' ? <CircularProgress size={16} color="inherit" /> : <CloudOffIcon fontSize="small" />}
          >
            Unpublish
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={addToSeriesDialogOpen}
        onClose={() => {
          if (isAddingToSeries) {
            return;
          }
          setAddToSeriesDialogOpen(false);
          setOwnedSeriesSearchQuery('');
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add Sermon To Series</DialogTitle>
        <DialogContent>
          {loadingOwnedSeries ? (
            <Box sx={{ py: 3, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={24} />
            </Box>
          ) : ownedSeriesOptions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              You don&apos;t have any series yet. Create one first from the series page.
            </Typography>
          ) : (
            <Autocomplete
              fullWidth
              options={ownedSeriesOptions}
              value={selectedOwnedSeries}
              disabled={isAddingToSeries}
              inputValue={ownedSeriesSearchQuery}
              onInputChange={(_, newInputValue) => setOwnedSeriesSearchQuery(newInputValue)}
              onChange={(_, newValue) => {
                setSelectedOwnedSeriesId(newValue?.id || '');
              }}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderOption={(renderProps, option) => (
                <ListItem {...renderProps} key={option.id}>
                  <AvatarWithDefaultImage
                    defaultImageURL="/sermon_default.png"
                    altName={option.name}
                    width={28}
                    height={28}
                    image={option.images?.find((image) => image.type === 'square')}
                    borderRadius={5}
                    sx={{ marginRight: '12px' }}
                  />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{option.name}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {option.publishedItemCount || 0} part series
                    </Typography>
                  </Box>
                </ListItem>
              )}
              renderInput={(params) => (
                <TextField
                  {...params}
                  margin="dense"
                  label="Select your series"
                  placeholder="Search your series..."
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: selectedOwnedSeries ? (
                      <InputAdornment position="start">
                        <AvatarWithDefaultImage
                          defaultImageURL="/sermon_default.png"
                          altName={selectedOwnedSeries.name}
                          width={26}
                          height={26}
                          image={selectedOwnedSeries.images?.find((image) => image.type === 'square')}
                          borderRadius={5}
                        />
                      </InputAdornment>
                    ) : params.InputProps.startAdornment,
                  }}
                />
              )}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setAddToSeriesDialogOpen(false);
              setOwnedSeriesSearchQuery('');
            }}
            disabled={isAddingToSeries}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={addSermonToSelectedSeries}
            disabled={isAddingToSeries || loadingOwnedSeries || ownedSeriesOptions.length === 0 || !selectedOwnedSeriesId}
            startIcon={isAddingToSeries ? <CircularProgress size={16} color="inherit" /> : <AddIcon fontSize="small" />}
          >
            Add To Series
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Popup */}
      {deletePopup && (
        <DeleteEntityPopup
          entityBeingDeleted="sermon"
          handleDelete={handleDelete}
          deleteConfirmationPopup={deletePopup}
          setDeleteConfirmationPopup={setDeletePopup}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
};

const ProtectedSermonDetailsPage = () => {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return <SermonDetailsPage />;
};

ProtectedSermonDetailsPage.PageLayout = AppLayout;

export default ProtectedSermonDetailsPage;
