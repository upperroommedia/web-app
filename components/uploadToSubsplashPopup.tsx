import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import storage, { getDownloadURL, ref } from '../firebase/storage';
import firestore, { doc, updateDoc, getDocs, collection } from '../firebase/firestore';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { AddToSeriesInputType } from '../functions/src/addToSeries';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../functions/src/createNewSubsplashList';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { Series, seriesConverter } from '../types/Series';
import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { createFunction, createFunctionV2 } from '../utils/createFunction';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import PopUp from './PopUp';
import SeriesSelector from './SeriesSelector';

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
  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [seriesArray, setSeriesArray] = useState<Series[]>([]);

  useEffect(() => {
    const g = async () => {
      const series = await getDocs(collection(firestore, 'series').withConverter(seriesConverter));
      setSeriesArray(series.docs.map((doc) => doc.data()));
    };
    g();
  }, []);

  const uploadToSubsplash = async () => {
    const uploadToSubsplashCallable = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
    const addToSeries = createFunctionV2<AddToSeriesInputType, void>('addtoseries');
    const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.key}`));
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
    try {
      // TODO [1]: Fix return Type
      const response = (await uploadToSubsplashCallable(data)) as unknown as { id: string };
      const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
      const id = response.id;
      await updateDoc(sermonRef, { subsplashId: id });
      // get series
      const seriesSnapshot = await getDocs(
        collection(firestore, `sermons/${sermonRef.id}/series`).withConverter(seriesConverter)
      );
      // get/create subsplashListId and overflow behavior
      const seriesMetadata = await Promise.all(
        seriesSnapshot.docs.map(async (snapshot) => {
          const series = snapshot.data();
          if (series.subsplashId) {
            return { listId: series.subsplashId, overflowBehavior: series.overflowBehavior };
          }
          // upload series to subsplash
          const createNewSubsplashList = createFunctionV2<
            CreateNewSubsplashListInputType,
            CreateNewSubsplashListOutputType
          >('createnewsubsplashlist');
          const { listId } = await createNewSubsplashList({
            title: series.name,
            subtitle: '',
            images: series.images,
          });
          await updateDoc(snapshot.ref, { subsplashId: listId });
          return { listId, overflowBehavior: series.overflowBehavior };
        })
      );

      await addToSeries({
        seriesMetadata,
        mediaItemIds: [{ id, type: 'media-item' }],
      });
      await updateDoc(sermonRef, { status: { ...sermon.status, subsplash: uploadStatus.UPLOADED } });
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
        <SeriesSelector sermonSeries={seriesArray} />
        <Box display="flex" alignItems={'center'} onClick={() => setAutoPublish((previousValue) => !previousValue)}>
          <Checkbox checked={autoPublish} />
          <Typography>Auto publish when upload is complete</Typography>
        </Box>
      </Box>
    </PopUp>
  );
};

export default UploadToSubsplashPopup;
