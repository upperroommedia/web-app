/**
 * ManagePublishingPopup - Unified popup for managing publishing to SoundCloud and Subsplash
 * Combines functionality from ManageUploadsPopup and ManageSoundcloudButton
 */
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Card from '@mui/material/Card';
import Alert from '@mui/material/Alert';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import CloseIcon from '@mui/icons-material/Close';
import CloudIcon from '@mui/icons-material/Cloud';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import CollectionsIcon from '@mui/icons-material/Collections';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, { doc, updateDoc, collection, writeBatch, getDoc, getDocs, deleteField, setDoc, query, orderBy } from '../firebase/firestore';
import { FunctionComponent, useCallback, useEffect, useState } from 'react';
import { AddtoListInputType, AddToListOutputType } from '../functions/src/addToList';
import { RemoveFromListInputType, RemoveFromListOutputType } from '../functions/src/removeFromList';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../functions/src/createNewSubsplashList';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../functions/src/uploadToSoundCloud';
import { CreateSeriesInputType, CreateSeriesOutputType } from '../functions/src/createSeries';
import { AddToSeriesInputType, AddToSeriesOutputType } from '../functions/src/addToSeries';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../functions/src/reorderSeriesItems';
import { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '../functions/src/removeFromSeries';
import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { Series, seriesConverter } from '../types/Series';
import { createFunctionV2 } from '../utils/createFunction';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { SermonList, sermonListConverter } from '../types/SermonList';
import useAuth from '../context/user/UserContext';
import UploadStatusList from './UploadStatusList';
import { isDevelopment } from '../firebase/firebase';
import CountOfUploadsCircularProgress from './CountOfUploadsCircularProgress';
import Link from 'next/link';
import { getSquareImageStoragePath } from '../utils/utils';
import { alpha, useTheme } from '@mui/material/styles';

interface ManagePublishingPopupProps {
  sermon: Sermon;
  open: boolean;
  onClose: () => void;
  onUpdate?: () => void;
}

interface ListPublishResult {
  status: 'success' | 'error';
  mediaItemId?: string;
  error?: string;
}

interface SeriesPublishResult {
  status: 'success' | 'error';
  error?: string;
}

const ManagePublishingPopup: FunctionComponent<ManagePublishingPopupProps> = ({
  sermon,
  open,
  onClose,
  onUpdate,
}) => {
  const { user } = useAuth();
  const theme = useTheme();
  const [listArray, setListArray] = useState<SermonList[]>([]);
  const [listArrayFirestore, loading, error] = useCollectionData(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter)
  );

  // SoundCloud state
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState(false);
  const [soundCloudError, setSoundCloudError] = useState<string | null>(null);

  // Subsplash state
  const [isUploadingToSubsplash, setIsUploadingToSubsplash] = useState(false);

  // Series state
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesPublished, setSeriesPublished] = useState(false);
  const [isPublishingToSeries, setIsPublishingToSeries] = useState(false);
  const [isUnpublishingFromSeries, setIsUnpublishingFromSeries] = useState(false);
  const [isPublishingEverywhere, setIsPublishingEverywhere] = useState(false);

  useEffect(() => {
    if (listArrayFirestore) {
      setListArray(listArrayFirestore);
    }
  }, [listArrayFirestore]);

  // Fetch series if sermon has seriesId
  useEffect(() => {
    const fetchSeries = async () => {
      if (!sermon.seriesId) {
        setSeries(null);
        return;
      }

      setSeriesLoading(true);
      try {
        const seriesDoc = await getDoc(doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter));
        if (seriesDoc.exists()) {
          const seriesData = seriesDoc.data();
          setSeries(seriesData);
          
          const seriesItemDoc = await getDoc(doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id));
          if (seriesItemDoc.exists()) {
            setSeriesPublished(seriesItemDoc.data()?.publishedToSubsplash === true);
          } else {
            setSeriesPublished(false);
          }
        }
      } catch (err) {
        console.error('Error fetching series:', err);
      }
      setSeriesLoading(false);
    };

    if (open) {
      fetchSeries();
    }
  }, [sermon.seriesId, sermon.id, open]);

  const listItemsNotUploaded = listArray.filter((list) => list.uploadStatus?.status !== uploadStatus.UPLOADED);
  const listItemsUploaded = listArray.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED);

  // ==================== SoundCloud Functions ====================
  const uploadToSoundCloud = useCallback(async () => {
    setIsUploadingToSoundCloud(true);
    setSoundCloudError(null);
    
    const uploadToSoundCloudFn = createFunctionV2<UploadToSoundCloudInputType, UploadToSoundCloudReturnType>(
      'uploadtosoundcloud'
    );

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
      onUpdate?.();
    } catch (error: any) {
      console.error('Error uploading to SoundCloud:', error);
      setSoundCloudError(error.message || 'Failed to upload to SoundCloud');
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [sermon, onUpdate]);

  const deleteFromSoundCloud = useCallback(async () => {
    setIsUploadingToSoundCloud(true);
    setSoundCloudError(null);
    
    const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
    
    if (!sermon.soundCloudTrackId) {
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
      setIsUploadingToSoundCloud(false);
      onUpdate?.();
      return;
    }
    
    const deleteFromSoundCloudFn = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
    
    try {
      await deleteFromSoundCloudFn({ soundCloudTrackId: sermon.soundCloudTrackId });
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
      onUpdate?.();
    } catch (error: any) {
      if (error.details?.includes('Invalid track id')) {
        await updateDoc(sermonRef, {
          soundCloudTrackId: deleteField(),
          status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
        });
        onUpdate?.();
      } else {
        console.error('Error deleting from SoundCloud:', error);
        setSoundCloudError(error.message || 'Failed to remove from SoundCloud');
      }
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  }, [sermon, onUpdate]);

  // ==================== Subsplash Functions ====================
  const deleteFromSubsplash = useCallback(async () => {
    const deleteFromSubsplashCall = createFunctionV2<{ subsplashId: string }, void>('deletefromsubsplash');
    try {
      setIsUploadingToSubsplash(true);
      if (sermon.subsplashId) {
        await deleteFromSubsplashCall({ subsplashId: sermon.subsplashId });
      }
      
      const batch = writeBatch(firestore);
      const sermonSeriesList = collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter);
      const sermonSeriesListSnapshot = await getDocs(sermonSeriesList);
      sermonSeriesListSnapshot.forEach((docSnap: any) => {
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
      setSeriesPublished(false);
      onUpdate?.();
    } catch (error: any) {
      if (error.code === 'functions/not-found') {
        // Item already deleted from Subsplash
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
        setSeriesPublished(false);
        onUpdate?.();
      } else {
        console.error('Error deleting from Subsplash:', error);
        alert(error.message || 'Failed to delete from Subsplash');
      }
    } finally {
      setIsUploadingToSubsplash(false);
    }
  }, [sermon, onUpdate]);

  const uploadToSubsplash = async (
    listsToUploadTo: SermonList[],
    options?: { suppressAlert?: boolean }
  ): Promise<ListPublishResult> => {
    setIsUploadingToSubsplash(true);
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
          const createNewSubsplashList = createFunctionV2<CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType>(
            'createnewsubsplashlist'
          );
          const { listId } = await createNewSubsplashList({
            title: list.name,
            subtitle: '',
            images: list.images,
          });
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
        if (!listId) {
          throw new Error(`ListId for subsplashList ${r.listId} not found`);
        }
        const docRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${listId}`).withConverter(sermonListConverter);
        if (r.status === 'success') {
          batch.update(docRef, { uploadStatus: { status: uploadStatus.UPLOADED, listItemId: r.listItemId } });
        } else {
          batch.update(docRef, { uploadStatus: { status: uploadStatus.ERROR, reason: r.error } });
        }
      });

      batch.update(sermonRef, {
        status: { ...sermon.status, subsplash: uploadStatus.UPLOADED },
        approverId: user?.uid,
      });

      await batch.commit();
      onUpdate?.();
      return {
        status: 'success',
        mediaItemId: id,
      };
    } catch (error: any) {
      console.error('Error uploading to Subsplash:', error);
      const errorMessage = error?.message || 'Unknown error';
      if (!options?.suppressAlert) {
        alert(errorMessage);
      }
      return {
        status: 'error',
        error: errorMessage,
      };
    } finally {
      setIsUploadingToSubsplash(false);
    }
  };

  const removeFromList = async (listsToRemoveFrom: SermonList[]) => {
    try {
      const removeFromListCallable = createFunctionV2<RemoveFromListInputType, RemoveFromListOutputType>('removefromlist');
      const listsToRemoveFiltered = listsToRemoveFrom.filter(
        (list) => list.uploadStatus?.status === uploadStatus.UPLOADED && list.uploadStatus.listItemId
      );
      
      const subsplashIdToFirestoreIdMap = new Map<string, string>();
      listsToRemoveFiltered.forEach((list) => {
        if (list.subsplashId) {
          subsplashIdToFirestoreIdMap.set(list.subsplashId, list.id);
        }
      });
      
      const removeFromListReturn = await removeFromListCallable({
        listIds: listsToRemoveFiltered.map((list) => list.subsplashId) as string[],
        listItemIds: listsToRemoveFiltered.map((list) =>
          list.uploadStatus?.status === uploadStatus.UPLOADED ? list.uploadStatus.listItemId : ''
        ) as string[],
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
      onUpdate?.();
    } catch (error) {
      console.error('Error removing from list:', error);
      alert(error);
    }
  };

  // ==================== Series Functions ====================
  const reorderSeriesFromFirebaseOrder = async (
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

      const isPublished = seriesItemDoc.id === newlyPublishedSermonId
        ? true
        : data.publishedToSubsplash === true;
      const mediaItemId = seriesItemDoc.id === newlyPublishedSermonId
        ? newlyPublishedMediaItemId
        : data.sermonSubsplashId;

      return {
        sermonId: seriesItemDoc.id,
        isPublished,
        mediaItemId,
      };
    });

    const targetExists = orderedItems.some((item) => item.sermonId === newlyPublishedSermonId);
    if (!targetExists) {
      throw new Error('Series item is missing from Firestore order. Refresh and try again.');
    }

    const publishedItems = orderedItems.filter((item) => item.isPublished);
    const missingMediaId = publishedItems.find((item) => !item.mediaItemId);
    if (missingMediaId) {
      throw new Error(`Published series item ${missingMediaId.sermonId} is missing a Subsplash media ID.`);
    }

    const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>(
      'reorderseriesitems'
    );
    const reorderResult = await reorderFunction({
      firestoreSeriesId: seriesId,
      itemOrder: publishedItems.map((item, index) => ({
        mediaItemId: item.mediaItemId as string,
        // Subsplash uses inverted ordering semantics: position 1 is the bottom item.
        position: publishedItems.length - index,
      })),
    });

    if (reorderResult.status !== 'success') {
      throw new Error(reorderResult.message || 'Subsplash reorder failed.');
    }
  };

  const publishToSeries = async (options?: { mediaItemId?: string; suppressAlert?: boolean }): Promise<SeriesPublishResult> => {
    const mediaItemId = options?.mediaItemId || sermon.subsplashId;
    if (!series || !mediaItemId) {
      const message = 'Sermon must be uploaded to Subsplash first before adding to series';
      if (!options?.suppressAlert) {
        alert(message);
      }
      return {
        status: 'error',
        error: message,
      };
    }

    setIsPublishingToSeries(true);
    try {
      let seriesSubsplashId = series.subsplashId;

      if (!seriesSubsplashId) {
        const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
        const createResult = await createSeriesFunction({
          title: series.name,
          summary: series.summary,
          ownerId: series.ownerId,
          skipSubsplash: false,
        });

        if (createResult.status !== 'success' || !createResult.subsplashId) {
          throw new Error(createResult.error || 'Failed to create series in Subsplash');
        }

        seriesSubsplashId = createResult.subsplashId;
        await updateDoc(doc(firestore, 'series', series.id), {
          subsplashId: seriesSubsplashId,
          status: 'published',
        });
        setSeries((prev) => prev ? { ...prev, subsplashId: seriesSubsplashId, status: 'published' } : prev);
      }

      const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
      const addResult = await addToSeriesFunction({
        seriesSubsplashId,
        mediaItemId,
      });

      if (!addResult || addResult.status !== 'success') {
        throw new Error(addResult.error || 'Failed to add sermon to series');
      }
      if (addResult.confirmedSeriesId !== seriesSubsplashId) {
        throw new Error(
          `Subsplash did not confirm series assignment. Expected ${seriesSubsplashId}, got ${addResult.confirmedSeriesId || 'null'}.`
        );
      }

      try {
        await reorderSeriesFromFirebaseOrder(
          series.id,
          sermon.id,
          addResult.mediaItemId || mediaItemId
        );
      } catch (reorderError: any) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        try {
          await removeFromSeriesFunction({
            mediaItemId: addResult.mediaItemId || mediaItemId,
          });
        } catch (rollbackError: any) {
          throw new Error(
            `Series reorder failed and rollback failed. Reorder error: ${reorderError?.message || 'Unknown'}; rollback error: ${rollbackError?.message || 'Unknown'}`
          );
        }
        throw new Error(reorderError?.message || 'Series reorder failed after publish.');
      }

      const seriesItemRef = doc(firestore, `series/${series.id}/seriesItems`, sermon.id);
      await setDoc(
        seriesItemRef,
        {
          publishedToSubsplash: true,
          sermonSubsplashId: addResult.mediaItemId || mediaItemId,
        },
        { merge: true }
      );

      const verificationSnapshot = await getDoc(seriesItemRef);
      if (
        !verificationSnapshot.exists() ||
        verificationSnapshot.data()?.publishedToSubsplash !== true
      ) {
        throw new Error('Series publish did not persist locally. Please refresh and retry.');
      }

      setSeriesPublished(true);
      onUpdate?.();
      return {
        status: 'success',
      };
    } catch (err: any) {
      console.error('Error publishing to series:', err);
      setSeriesPublished(false);
      const errorMessage = err.message || 'Unknown error';
      if (!options?.suppressAlert) {
        alert(`Error publishing to series: ${errorMessage}`);
      }
      return {
        status: 'error',
        error: errorMessage,
      };
    } finally {
      setIsPublishingToSeries(false);
    }
  };

  const unpublishFromSeries = async (options?: { suppressAlert?: boolean }): Promise<SeriesPublishResult> => {
    if (!series) {
      return {
        status: 'error',
        error: 'Series not found',
      };
    }

    setIsUnpublishingFromSeries(true);
    try {
      const seriesItemRef = doc(firestore, `series/${series.id}/seriesItems`, sermon.id);
      const seriesItemSnapshot = await getDoc(seriesItemRef);
      const seriesItemData = seriesItemSnapshot.exists()
        ? (seriesItemSnapshot.data() as { sermonSubsplashId?: string })
        : null;
      const mediaItemId = seriesItemData?.sermonSubsplashId || sermon.subsplashId;

      if (mediaItemId) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        await removeFromSeriesFunction({ mediaItemId });
      }

      if (seriesItemSnapshot.exists()) {
        await updateDoc(seriesItemRef, {
          publishedToSubsplash: false,
          sermonSubsplashId: deleteField(),
        });
      }

      setSeriesPublished(false);
      onUpdate?.();
      return {
        status: 'success',
      };
    } catch (err: any) {
      console.error('Error unpublishing from series:', err);
      const errorMessage = err.message || 'Unknown error';
      if (!options?.suppressAlert) {
        alert(`Error unpublishing from series: ${errorMessage}`);
      }
      return {
        status: 'error',
        error: errorMessage,
      };
    } finally {
      setIsUnpublishingFromSeries(false);
    }
  };

  const publishEverywhere = async (listsToUploadTo: SermonList[]) => {
    if (isPublishingEverywhere) return;

    setIsPublishingEverywhere(true);
    let mediaItemId = sermon.subsplashId;
    let listsPublished = listsToUploadTo.length === 0;
    let seriesWasPublished = seriesPublished;
    const errors: string[] = [];

    try {
      if (listsToUploadTo.length > 0) {
        const listResult = await uploadToSubsplash(listsToUploadTo, { suppressAlert: true });
        if (listResult.status === 'success') {
          listsPublished = true;
          mediaItemId = listResult.mediaItemId || mediaItemId;
        } else {
          errors.push(`Lists: ${listResult.error || 'Unknown error'}`);
        }
      }

      if (!mediaItemId && !seriesPublished) {
        const uploadResult = await uploadToSubsplash([], { suppressAlert: true });
        if (uploadResult.status === 'success') {
          mediaItemId = uploadResult.mediaItemId || mediaItemId;
        } else {
          errors.push(`Series setup: ${uploadResult.error || 'Unknown error'}`);
        }
      }

      if (!seriesPublished) {
        const seriesResult = await publishToSeries({
          mediaItemId,
          suppressAlert: true,
        });
        if (seriesResult.status === 'success') {
          seriesWasPublished = true;
        } else {
          errors.push(`Series: ${seriesResult.error || 'Unknown error'}`);
        }
      }

      if (errors.length === 0) {
        alert('Publish Everywhere completed successfully.');
        return;
      }

      if (listsPublished || seriesWasPublished) {
        alert(`Publish Everywhere partially succeeded:\n${errors.join('\n')}`);
        return;
      }

      alert(`Publish Everywhere failed:\n${errors.join('\n')}`);
    } finally {
      setIsPublishingEverywhere(false);
    }
  };

  const handlePublishToSubsplash = async (listsToUploadTo: SermonList[]) => {
    await uploadToSubsplash(listsToUploadTo);
  };

  const handlePublishToSeries = async () => {
    let mediaItemId = sermon.subsplashId;
    if (!mediaItemId) {
      const uploadResult = await uploadToSubsplash([], { suppressAlert: true });
      if (uploadResult.status !== 'success') {
        alert(`Error preparing sermon for series publish: ${uploadResult.error || 'Unknown error'}`);
        return;
      }
      mediaItemId = uploadResult.mediaItemId;
    }

    await publishToSeries({ mediaItemId });
  };

  const isSoundCloudUploaded = sermon.status.soundCloud === uploadStatus.UPLOADED;
  const uploadedListsCount = listArrayFirestore?.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED).length || 0;
  const totalListsCount = listArrayFirestore?.length || 0;

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="md" 
      fullWidth
      PaperProps={{ sx: { borderRadius: 2 } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <AvatarWithDefaultImage
            altName={sermon.title}
            image={sermon.images?.find((image) => image.type === 'square')}
            width={48}
            height={48}
            borderRadius={8}
          />
          <Box>
            <Typography variant="h6" fontWeight={600}>Manage Publishing</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sermon.title}
            </Typography>
          </Box>
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      
      <Divider />
      
      <DialogContent sx={{ p: 3 }}>
        <Stack spacing={3}>
          {/* SoundCloud Section */}
          <Box>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <CloudIcon /> SoundCloud
            </Typography>
            
            <Card 
              variant="outlined" 
              sx={{ 
                p: 2,
                bgcolor: isSoundCloudUploaded ? alpha(theme.palette.success.main, 0.05) : 'background.paper',
                borderColor: isSoundCloudUploaded ? 'success.main' : 'divider',
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  {isSoundCloudUploaded ? (
                    <CheckCircleIcon color="success" />
                  ) : (
                    <PendingIcon color="disabled" />
                  )}
                  <Box>
                    <Typography variant="body1" fontWeight={500}>
                      {isSoundCloudUploaded ? 'Published to SoundCloud' : 'Not Published'}
                    </Typography>
                    {sermon.soundCloudTrackId && (
                      <Typography variant="caption" color="text.secondary">
                        Track ID: {sermon.soundCloudTrackId}
                      </Typography>
                    )}
                  </Box>
                </Box>
                
                {isUploadingToSoundCloud ? (
                  <CircularProgress size={24} />
                ) : isSoundCloudUploaded ? (
                  <Button
                    variant="outlined"
                    color="error"
                    size="small"
                    startIcon={<CloudOffIcon />}
                    onClick={deleteFromSoundCloud}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<CloudUploadIcon />}
                    onClick={uploadToSoundCloud}
                    disabled={isDevelopment}
                  >
                    {isDevelopment ? 'Dev Mode' : 'Upload'}
                  </Button>
                )}
              </Stack>
              
              {soundCloudError && (
                <Alert severity="error" sx={{ mt: 2 }}>{soundCloudError}</Alert>
              )}
            </Card>
          </Box>

          <Divider />

          {/* Subsplash Section */}
          <Box>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <CollectionsIcon /> Subsplash Lists
              <CountOfUploadsCircularProgress
                sermonNumberOfListsUploadedTo={uploadedListsCount}
                sermonNumberOfLists={totalListsCount}
              />
            </Typography>

            {error ? (
              <Alert severity="error">{error.message}</Alert>
            ) : loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                <CircularProgress />
              </Box>
            ) : (
              <Stack spacing={2}>
                {/* Series Section */}
                {sermon.seriesId && (
                  <Card variant="outlined" sx={{ p: 2 }}>
                    <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                      Series
                    </Typography>
                    {seriesLoading ? (
                      <CircularProgress size={20} />
                    ) : series ? (
                      <Stack direction="row" spacing={2} alignItems="center">
                        <AvatarWithDefaultImage
                          image={series.images?.find((img) => img.type === 'square')}
                          altName={series.name}
                          width={40}
                          height={40}
                          borderRadius={6}
                        />
                        <Box flex={1}>
                          <Link href={`/admin/series/${series.id}`}>
                            <Typography
                              variant="body2"
                              sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                            >
                              {series.name}
                            </Typography>
                          </Link>
                          <Chip
                            icon={seriesPublished ? <CheckCircleIcon /> : <PendingIcon />}
                            label={seriesPublished ? 'Published' : 'Not Published'}
                            size="small"
                            color={seriesPublished ? 'success' : 'warning'}
                            variant="outlined"
                            sx={{ height: 22, mt: 0.5 }}
                          />
                        </Box>
                        {!seriesPublished && (
                          <Button
                            size="small"
                            variant="contained"
                            onClick={handlePublishToSeries}
                            disabled={isPublishingToSeries || isUnpublishingFromSeries || isPublishingEverywhere || isUploadingToSubsplash}
                          >
                            {isPublishingToSeries ? (
                              <CircularProgress size={20} />
                            ) : sermon.subsplashId ? (
                              'Publish to Series'
                            ) : (
                              'Upload & Publish to Series'
                            )}
                          </Button>
                        )}
                        {seriesPublished && (
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            onClick={() => unpublishFromSeries()}
                            disabled={isPublishingToSeries || isUnpublishingFromSeries || isPublishingEverywhere || isUploadingToSubsplash}
                          >
                            {isUnpublishingFromSeries ? <CircularProgress size={20} /> : 'Unpublish from Series'}
                          </Button>
                        )}
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">Series not found</Typography>
                    )}
                  </Card>
                )}

                {/* Uploaded Lists */}
                <UploadStatusList
                  key={listItemsUploaded.map((list) => list.id).join('') + 'Uploaded'}
                  sectionTitle="Published to Lists"
                  sermonListItems={listItemsUploaded}
                  buttonAction={removeFromList}
                  allSelectedButtonAction={deleteFromSubsplash}
                  buttonLabel="Remove From Lists"
                  buttonColorVariant="error"
                />
                
                {/* Not Uploaded Lists */}
                <UploadStatusList
                  key={listItemsNotUploaded.map((list) => list.id).join('') + 'NotUploaded'}
                  sectionTitle="Not Published"
                  sermonListItems={listItemsNotUploaded}
                  buttonAction={handlePublishToSubsplash}
                  buttonLabel="Publish to Subsplash"
                  secondaryButtonAction={sermon.seriesId && !seriesPublished ? publishEverywhere : undefined}
                  secondaryButtonLabel={sermon.seriesId && !seriesPublished ? 'Publish Everywhere' : undefined}
                  secondaryButtonColorVariant="secondary"
                />
              </Stack>
            )}
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
};

export default ManagePublishingPopup;
