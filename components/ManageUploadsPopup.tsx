import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, { doc, updateDoc, collection, writeBatch, getDoc } from '../firebase/firestore';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { AddtoListInputType, AddToListOutputType } from '../functions/src/addToList';
import { RemoveFromListInputType, RemoveFromListOutputType } from '../functions/src/removeFromList';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../functions/src/createNewSubsplashList';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { CreateSeriesInputType, CreateSeriesOutputType } from '../functions/src/createSeries';
import { AddToSeriesInputType, AddToSeriesOutputType } from '../functions/src/addToSeries';
import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { Series, seriesConverter } from '../types/Series';
import { createFunctionV2 } from '../utils/createFunction';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import PopUp from './PopUp';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { SermonList, sermonListConverter } from '../types/SermonList';
import useAuth from '../context/user/UserContext';
import UploadStatusList from './UploadStatusList';
import { isDevelopment } from '../firebase/firebase';
import CountOfUploadsCircularProgress from './CountOfUploadsCircularProgress';
import Link from 'next/link';

interface ManageUploadsPopupProps {
  sermon: Sermon;
  manageUploadsPopupBoolean: boolean;
  setManageUploadsPopupBoolean: (boolean: boolean) => void;
  setIsUploadingToSubsplash: Dispatch<SetStateAction<boolean>>;
  deleteFromSubsplash: () => Promise<void>;
}

const ManageUploadsPopup: FunctionComponent<ManageUploadsPopupProps> = ({
  sermon,
  manageUploadsPopupBoolean,
  setManageUploadsPopupBoolean,
  setIsUploadingToSubsplash,
  deleteFromSubsplash,
}: ManageUploadsPopupProps) => {
  const { user } = useAuth();
  const [listArray, setListArray] = useState<SermonList[]>([]);
  const [listArrayFirestore, loading, error] = useCollectionData(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter)
  );

  // Series state
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesPublished, setSeriesPublished] = useState(false);
  const [isPublishingToSeries, setIsPublishingToSeries] = useState(false);

  useEffect(() => {
    if (listArrayFirestore) {
      setListArray(listArrayFirestore);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(listArrayFirestore)]);

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
          
          // Check if sermon is already published to this series
          const seriesItemDoc = await getDoc(doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id));
          setSeriesPublished(seriesItemDoc.exists() && seriesItemDoc.data()?.publishedToSubsplash === true);
        }
      } catch (err) {
        console.error('Error fetching series:', err);
      }
      setSeriesLoading(false);
    };

    fetchSeries();
  }, [sermon.seriesId, sermon.id]);

  const listItemsNotUploaded = listArray.filter((list) => list.uploadStatus?.status !== uploadStatus.UPLOADED);
  const listItemsUploaded = listArray.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED);

  // Publish sermon to series in Subsplash
  const publishToSeries = async () => {
    if (!series || !sermon.subsplashId) {
      alert('Sermon must be uploaded to Subsplash first before adding to series');
      return;
    }

    setIsPublishingToSeries(true);
    try {
      let seriesSubsplashId = series.subsplashId;

      // If series doesn't have a subsplashId, create it in Subsplash first
      if (!seriesSubsplashId) {
        const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
        const createResult = await createSeriesFunction({
          title: series.name,
          subtitle: series.subtitle,
          summary: series.summary,
          ownerId: series.ownerId,
          skipSubsplash: false, // Create in Subsplash
        });

        if (createResult.status !== 'success' || !createResult.subsplashId) {
          throw new Error(createResult.error || 'Failed to create series in Subsplash');
        }

        seriesSubsplashId = createResult.subsplashId;

        // Update series in Firestore with new subsplashId
        await updateDoc(doc(firestore, 'series', series.id), {
          subsplashId: seriesSubsplashId,
          status: 'published',
        });

        // Update local state
        setSeries((prev) => prev ? { ...prev, subsplashId: seriesSubsplashId, status: 'published' } : prev);
      }

      // Add sermon to series in Subsplash
      const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
      const addResult = await addToSeriesFunction({
        seriesSubsplashId: seriesSubsplashId,
        mediaItemId: sermon.subsplashId,
      });

      if (addResult.status !== 'success') {
        throw new Error(addResult.error || 'Failed to add sermon to series');
      }

      // Update series item in Firestore (gracefully handle if it doesn't exist)
      const seriesItemRef = doc(firestore, `series/${series.id}/seriesItems`, sermon.id);
      const seriesItemDoc = await getDoc(seriesItemRef);
      
      if (seriesItemDoc.exists()) {
        await updateDoc(seriesItemRef, {
          publishedToSubsplash: true,
          sermonSubsplashId: sermon.subsplashId,
        });
      } else {
        // SeriesItem doesn't exist - sermon may have been removed from series
        console.warn(`SeriesItem ${sermon.id} not found in series ${series.id}`);
        alert('Warning: Sermon was published to Subsplash series, but is no longer in this series in Firestore.');
      }

      setSeriesPublished(true);
      alert('Successfully published to series!');
    } catch (err: any) {
      console.error('Error publishing to series:', err);
      alert(`Error publishing to series: ${err.message || 'Unknown error'}`);
    }
    setIsPublishingToSeries(false);
  };

  const uploadToSubsplash = async (listsToUploadTo: SermonList[]) => {
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
      // TODO [1]: Fix return Type
      let id = sermon.subsplashId;
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      if (!id) {
        const response = (await uploadToSubsplashCallable(data)) as unknown as { id: string };
        id = response.id;
        await updateDoc(sermonRef, { subsplashId: id });
      }
      // get series
      // get/create subsplashListId and overflow behavior
      const listsMetadata = await Promise.all(
        listsToUploadTo.map(async (list) => {
          if (list.subsplashId) {
            subsplashIdToListIdMap.set(list.subsplashId, list.id);
            return { listId: list.subsplashId, overflowBehavior: list.overflowBehavior, type: list.type };
          }
          // upload series to subsplash
          const createNewSubsplashList = createFunctionV2<
            CreateNewSubsplashListInputType,
            CreateNewSubsplashListOutputType
          >('createnewsubsplashlist');
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
      // await fetch(`/api/revalidate/sermons?secret=${process.env.NEXT_PUBLIC_REVALIDATE_SECRET}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      alert(error);
    }
    setIsUploadingToSubsplash(false);
  };

  const removeFromList = async (listsToRemoveFrom: SermonList[]) => {
    try {
      const removeFromListCallable = createFunctionV2<RemoveFromListInputType, RemoveFromListOutputType>(
        'removefromlist'
      );
      const listsToRemoveFiltered = listsToRemoveFrom.filter(
        (list) => list.uploadStatus?.status === uploadStatus.UPLOADED && list.uploadStatus.listItemId
      );
      
      // Create a map from subsplash ID to Firestore document ID
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
        if (r.status === 'error') {
          // Log error but don't throw - continue processing other items
          // eslint-disable-next-line no-console
          console.warn(`Error removing from list ${r.listId}:`, r.error);
          continue;
        }
        
        // Map subsplash ID back to Firestore document ID
        const firestoreListId = subsplashIdToFirestoreIdMap.get(r.listId);
        if (!firestoreListId) {
          // eslint-disable-next-line no-console
          console.warn(`Could not find Firestore document ID for subsplash list ${r.listId}`);
          continue;
        }
        
        const docRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${firestoreListId}`).withConverter(
          sermonListConverter
        );
        
        // Check if document exists before trying to update
        const docSnapshot = await getDoc(docRef);
        if (!docSnapshot.exists()) {
          // Document doesn't exist - this is fine, it means it was already removed
          // eslint-disable-next-line no-console
          console.warn(`Document ${firestoreListId} does not exist, skipping update`);
          continue;
        }
        
        batch.update(docRef, { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
      }
      
      await batch.commit();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      alert(error);
    }
  };

  return (
    <PopUp open={manageUploadsPopupBoolean} setOpen={() => setManageUploadsPopupBoolean(false)}>
      <Box display="flex" flexDirection="column" gap={1} sx={{ minWidth: { md: 400 } }}>
        <Box display="flex" alignItems="center" gap={1} marginBottom={1}>
          <AvatarWithDefaultImage
            altName={sermon.title}
            image={sermon.images.find((image) => image.type === 'square')}
            width={50}
            height={50}
            borderRadius={5}
          />
          <Typography variant="h6">{sermon.title}</Typography>
          <CountOfUploadsCircularProgress
            sermonNumberOfListsUploadedTo={listArrayFirestore?.filter(
              (list) => list.uploadStatus?.status === uploadStatus.UPLOADED
            ).length || 0}
            sermonNumberOfLists={listArrayFirestore?.length || 0}
          />
        </Box>

        {error ? (
          <Typography>{`Error: ${error.message}`}</Typography>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <>
            {/* Series Section */}
            {sermon.seriesId && (
              <>
                <Typography variant="subtitle2" color="text.secondary" mt={1}>
                  Series
                </Typography>
                <Box
                  display="flex"
                  alignItems="center"
                  gap={2}
                  p={1.5}
                  sx={{
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                  }}
                >
                  {seriesLoading ? (
                    <CircularProgress size={20} />
                  ) : series ? (
                    <>
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
                            sx={{ 
                              cursor: 'pointer',
                              '&:hover': { textDecoration: 'underline' }
                            }}
                          >
                            {series.name}
                          </Typography>
                        </Link>
                        <Box display="flex" gap={1} alignItems="center">
                          {seriesPublished ? (
                            <Chip
                              icon={<CheckCircleIcon />}
                              label="Published"
                              size="small"
                              color="success"
                              variant="outlined"
                              sx={{ height: 22 }}
                            />
                          ) : (
                            <Chip
                              icon={<PendingIcon />}
                              label="Not Published"
                              size="small"
                              color="warning"
                              variant="outlined"
                              sx={{ height: 22 }}
                            />
                          )}
                          {!series.subsplashId && (
                            <Typography variant="caption" color="text.secondary">
                              Series not yet in Subsplash
                            </Typography>
                          )}
                        </Box>
                      </Box>
                      {!seriesPublished && sermon.subsplashId && (
                        <Button
                          size="small"
                          variant="contained"
                          onClick={publishToSeries}
                          disabled={isPublishingToSeries}
                        >
                          {isPublishingToSeries ? (
                            <CircularProgress size={20} />
                          ) : (
                            'Publish to Series'
                          )}
                        </Button>
                      )}
                      {!sermon.subsplashId && !seriesPublished && (
                        <Typography variant="caption" color="text.secondary">
                          Upload sermon first
                        </Typography>
                      )}
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Series not found
                    </Typography>
                  )}
                </Box>
                <Divider sx={{ my: 1 }} />
              </>
            )}

            {/* Lists Section */}
            <UploadStatusList
              key={listItemsUploaded.map((list) => list.id).join('') + 'Uploaded'}
              sectionTitle="Uploaded"
              sermonListItems={listItemsUploaded}
              // TODO handle remove from subsplash and delete from subsplash
              buttonAction={removeFromList}
              allSelectedButtonAction={deleteFromSubsplash}
              buttonLabel="Remove From Lists"
              buttonColorVariant="error"
            />
            <UploadStatusList
              key={listItemsNotUploaded.map((list) => list.id).join('') + 'NotUploaded'}
              sectionTitle="Not Uploaded"
              sermonListItems={listItemsNotUploaded}
              buttonAction={uploadToSubsplash}
              buttonLabel="Upload to Subsplash"
            />
          </>
        )}
      </Box>
    </PopUp>
  );
};

export default ManageUploadsPopup;
