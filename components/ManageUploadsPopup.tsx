import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, { doc, updateDoc, collection, writeBatch } from '../firebase/firestore';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { AddtoListInputType, AddToListOutputType } from '../functions/src/addToList';
import { RemoveFromListInputType, RemoveFromListOutputType } from '../functions/src/removeFromList';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../functions/src/createNewSubsplashList';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { createFunction, createFunctionV2 } from '../utils/createFunction';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import PopUp from './PopUp';
// import SeriesSelector from './SeriesSelector';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { SermonList, sermonListConverter } from '../types/SermonList';
// import ListSelector from './ListSelector';
import useAuth from '../context/user/UserContext';
import UploadStatusList from './UploadStatusList';
import { isDevelopment } from '../firebase/firebase';
import CountOfUploadsCircularProgress from './CountOfUploadsCircularProgress';

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

  useEffect(() => {
    if (listArrayFirestore) {
      setListArray(listArrayFirestore);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(listArrayFirestore)]);

  const listItemsNotUploaded = listArray.filter((list) => list.uploadStatus?.status !== uploadStatus.UPLOADED);
  const listItemsUploaded = listArray.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED);

  const uploadToSubsplash = async (listsToUploadTo: SermonList[]) => {
    try {
      const subsplashIdToListIdMap = new Map<string, string>();
      const uploadToSubsplashCallable = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
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
        listsMetadata,
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
      const removeFromListCallable = createFunction<RemoveFromListInputType, RemoveFromListOutputType>(
        'removefromlist'
      );
      const listsToRemoveFiltered = listsToRemoveFrom.filter(
        (list) => list.uploadStatus?.status === uploadStatus.UPLOADED && list.uploadStatus.listItemId
      );
      const removeFromListReturn = await removeFromListCallable({
        listIds: listsToRemoveFiltered.map((list) => list.subsplashId) as string[],
        listItemIds: listsToRemoveFiltered.map((list) =>
          list.uploadStatus?.status === uploadStatus.UPLOADED ? list.uploadStatus.listItemId : ''
        ) as string[],
      });
      const batch = writeBatch(firestore);
      removeFromListReturn.forEach((r) => {
        const docRef = doc(firestore, `sermons/${sermon.id}/sermonLists/${r.listId}`).withConverter(
          sermonListConverter
        );
        if (r.status === 'success') {
          batch.update(docRef, { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
        } else {
          throw new Error(r.error);
        }
      });
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
            sermonNumberOfListsUploadedTo={sermon.numberOfListsUploadedTo}
            sermonNumberOfLists={sermon.numberOfLists}
          />
        </Box>
        {error ? (
          <Typography>{`Error: ${error.message}`}</Typography>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <>
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
