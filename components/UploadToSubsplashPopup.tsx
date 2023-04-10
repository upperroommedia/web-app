import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, { doc, updateDoc, collection } from '../firebase/firestore';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { AddtoListInputType } from '../functions/src/addToList';
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
import { useCollectionDataOnce } from 'react-firebase-hooks/firestore';
import { List, listConverter } from '../types/List';
import ListSelector from './ListSelector';
import useAuth from '../context/user/UserContext';

interface UploadToSubsplashPopupProps {
  sermon: Sermon;
  uploadToSubsplashPopupBoolean: boolean;
  setUploadToSubsplashPopupBoolean: (boolean: boolean) => void;
  setIsUploadingToSubsplash: Dispatch<SetStateAction<boolean>>;
  isUploadingToSubsplash: boolean;
}

const UploadToSubsplashPopup: FunctionComponent<UploadToSubsplashPopupProps> = ({
  sermon,
  uploadToSubsplashPopupBoolean,
  setUploadToSubsplashPopupBoolean,
  setIsUploadingToSubsplash,
  isUploadingToSubsplash,
}: UploadToSubsplashPopupProps) => {
  const { user } = useAuth();
  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [listArray, setListArray] = useState<List[]>([]);
  const [listArrayFirestore, loading, error] = useCollectionDataOnce(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(listConverter)
  );

  useEffect(() => {
    if (listArrayFirestore) {
      setListArray(listArrayFirestore);
    }
  }, [listArrayFirestore]);

  const uploadToSubsplash = async () => {
    try {
      const uploadToSubsplashCallable = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
      const addToList = createFunctionV2<AddtoListInputType, void>('addtolist');
      const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.id}`));
      const data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
        title: sermon.title,
        subtitle: sermon.subtitle,
        speakers: sermon.speakers,
        autoPublish,
        audioTitle: sermon.title,
        audioUrl: url,
        topics: sermon.topics,
        description: sermon.description,
        images: sermon.images,
        date: new Date(sermon.dateMillis),
      };
      setIsUploadingToSubsplash(true);
      // TODO [1]: Fix return Type
      const response = (await uploadToSubsplashCallable(data)) as unknown as { id: string };
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      const id = response.id;
      await updateDoc(sermonRef, { subsplashId: id });
      // get series
      // get/create subsplashListId and overflow behavior
      const listMetadata = await Promise.all(
        listArray.map(async (list) => {
          if (list.subsplashId) {
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
          return { listId, overflowBehavior: list.overflowBehavior, type: list.type };
        })
      );

      await addToList({
        listMetadata,
        mediaItemIds: [{ id, type: 'media-item' }],
      });
      await updateDoc(sermonRef, {
        status: { ...sermon.status, subsplash: uploadStatus.UPLOADED },
        approverId: user?.uid,
      });
    } catch (error) {
      alert(error);
    }
    setIsUploadingToSubsplash(false);
    setUploadToSubsplashPopupBoolean(false);
  };

  return (
    <PopUp
      title={'Upload Sermon to Supsplash?'}
      open={uploadToSubsplashPopupBoolean}
      setOpen={() => setUploadToSubsplashPopupBoolean(false)}
      button={
        <Button aria-label="Confirm Upload to Subsplash" onClick={uploadToSubsplash}>
          {isUploadingToSubsplash ? <CircularProgress /> : 'Upload'}
        </Button>
      }
    >
      <Box display="flex" flexDirection="column" gap={1}>
        <Box display="flex" alignItems="center" gap={1} marginBottom={1}>
          <AvatarWithDefaultImage
            altName={sermon.title}
            image={sermon.images.find((image) => image.type === 'square')}
            width={50}
            height={50}
            borderRadius={5}
          />
          <Typography variant="h6">{sermon.title}</Typography>
        </Box>
        <Typography variant="body1">The sermon will be added to the following lists:</Typography>
        {error ? (
          <Typography>{`Error: ${error.message}`}</Typography>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <ListSelector sermonList={listArray} setSermonList={setListArray} />
        )}
        <Box display="flex" alignItems={'center'} onClick={() => setAutoPublish((previousValue) => !previousValue)}>
          <Checkbox checked={autoPublish} />
          <Typography>Auto publish when upload is complete</Typography>
        </Box>
      </Box>
    </PopUp>
  );
};

export default UploadToSubsplashPopup;
