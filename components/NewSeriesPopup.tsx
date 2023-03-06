import { Button, TextField } from '@mui/material';
import firestore from '../firebase/firestore';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import dynamic from 'next/dynamic';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import addNewSeries from '../pages/api/addNewSeries';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import { emptySeries, Series, seriesConverter } from '../types/Series';
import ImageViewer from './ImageViewer';
import isEqual from 'lodash/isEqual';
import { Sermon } from '../types/SermonTypes';

const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });

interface NewSeriesPopupProps {
  newSeriesPopup: boolean;
  setNewSeriesPopup: Dispatch<SetStateAction<boolean>>;
  seriesArray: Series[];
  setSeriesArray: Dispatch<SetStateAction<Series[]>>;
  sermon?: Sermon;
  setSermon?: Dispatch<SetStateAction<Sermon>>;
  existingSeries?: Series | undefined;
}

const NewSeriesPopup = (props: NewSeriesPopupProps) => {
  const [newSeries, setNewSeries] = useState<Series>(props.existingSeries ? props.existingSeries : emptySeries);
  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });
  const [userHasTypedInSeries, setUserHasTypedInSeries] = useState<boolean>(false);
  useEffect(() => {
    if (props.existingSeries && newSeries.id !== props.existingSeries.id) {
      setNewSeries(props.existingSeries);
    }
  }, [props.existingSeries, newSeries]);

  const handleNewImage = (image: ImageType | ImageSizeType) => {
    setNewSeries((oldSeries) => {
      // check if image is ImageType or ImageSizeType
      if (isImageType(image)) {
        const castedImage = image as ImageType;
        let newImages: ImageType[] = [];
        if (oldSeries.images.find((img) => img.type === castedImage.type)) {
          newImages = oldSeries.images.map((img) => (img.type === castedImage.type ? castedImage : img));
        } else {
          newImages = [...oldSeries.images, castedImage];
        }
        return {
          ...oldSeries,
          images: newImages,
        };
      } else {
        const imageSizeType = image as ImageSizeType;
        return {
          ...oldSeries,
          images: oldSeries.images.filter((img) => img.type !== imageSizeType),
        };
      }
    });
  };

  useEffect(() => {
    if (!userHasTypedInSeries) {
      setNewSeriesError({ error: false, message: '' });
      return;
    }
    if (newSeries?.name === '') {
      setNewSeriesError({ error: true, message: 'Series cannot be empty' });
    } else if (
      newSeries?.name &&
      props.seriesArray.map((series) => series.name.toLowerCase()).includes(newSeries.name.toLowerCase())
    ) {
      setNewSeriesError({ error: true, message: 'Series already exists' });
    } else {
      setNewSeriesError({ error: false, message: '' });
    }
  }, [newSeries, userHasTypedInSeries, props.seriesArray]);

  return (
    <DynamicPopUp
      title={props.existingSeries ? 'Edit Series' : 'Add new series'}
      open={props.newSeriesPopup}
      setOpen={props.setNewSeriesPopup}
      onClose={() => {
        setUserHasTypedInSeries(false);
        setNewSeries(emptySeries);
      }}
      button={
        <Button
          variant="contained"
          disabled={
            (props.seriesArray.map((series) => series.name.toLowerCase()).includes(newSeries.name.toLowerCase()) &&
              isEqual(props.existingSeries?.images, newSeries.images)) ||
            newSeries.name === '' ||
            newSeries.images.length === 0
          }
          onClick={async () => {
            try {
              if (props.existingSeries) {
                const seriesRef = doc(firestore, 'series', newSeries.id);
                await updateDoc(seriesRef, {
                  ...newSeries,
                });
                props.setSeriesArray((oldSeriesArray) =>
                  oldSeriesArray.map((s) => {
                    if (s.id === newSeries.id) {
                      return { ...newSeries };
                    }
                    return s;
                  })
                );
                newSeries?.sermons.forEach((sermon) => {
                  const sermonRef = doc(firestore, 'sermons', sermon.key);
                  updateDoc(sermonRef, {
                    series: { ...newSeries },
                  });
                });
                props.setNewSeriesPopup(false);
                setUserHasTypedInSeries(false);
              } else {
                const newSeriesId = await addNewSeries(newSeries);
                const seriesToAdd = { id: newSeriesId, name: newSeries.name, sermons: [], images: newSeries.images };
                props.setNewSeriesPopup(false);
                props.seriesArray.push(seriesToAdd);
                if (props.sermon && props.setSermon) {
                  props.setSermon({ ...props.sermon, series: [...props.sermon.series, seriesToAdd] });
                  const newSeriesRef = doc(firestore, 'series', newSeriesId).withConverter(seriesConverter);
                  await updateDoc(newSeriesRef, { sermons: arrayUnion(props.sermon.key) });
                }
                setNewSeries(emptySeries);
                setUserHasTypedInSeries(false);
              }
            } catch (error) {
              console.error(error);
              setNewSeriesError({ error: true, message: JSON.stringify(error) });
            }
          }}
        >
          Submit
        </Button>
      }
    >
      <div style={{ display: 'flex', padding: '10px', justifyContent: 'center', flexDirection: 'column' }}>
        <TextField
          value={newSeries.name}
          onChange={(e) => {
            setNewSeries((oldSeries) => {
              return { ...oldSeries, name: e.target.value };
            });
            !userHasTypedInSeries && setUserHasTypedInSeries(true);
          }}
          error={newSeriesError.error}
          label={newSeriesError.error ? newSeriesError.message : 'Series'}
          sx={{ paddingBottom: '5px' }}
        />
        <ImageViewer images={newSeries.images} newImageCallback={handleNewImage} vertical={false} />
      </div>
    </DynamicPopUp>
  );
};

export default NewSeriesPopup;
