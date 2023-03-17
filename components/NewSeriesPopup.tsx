import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import firestore from '../firebase/firestore';
import { doc, updateDoc } from 'firebase/firestore';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import addNewSeries from '../pages/api/addNewSeries';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import { emptySeries, Series, OverflowBehavior, OverflowBehaviorType } from '../types/Series';
import ImageViewer from './ImageViewer';
import isEqual from 'lodash/isEqual';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import PopUp from '../components/PopUp';
import { CircularProgress } from '@mui/material';
import { EditSubsplashListInputType, EditSubsplashListOutputType } from '../functions/src/editSubsplashList';
import { createFunctionV2 } from '../utils/createFunction';

interface NewSeriesPopupProps {
  newSeriesPopup: boolean;
  setNewSeriesPopup: Dispatch<SetStateAction<boolean>>;
  seriesArray: Series[];
  setSeriesArray?: Dispatch<SetStateAction<Series[]>>;
  setSermonSeries?: Dispatch<SetStateAction<Series[]>>;
  existingSeries?: Series | undefined;
}

const NewSeriesPopup = (props: NewSeriesPopupProps) => {
  const [newSeries, setNewSeries] = useState<Series>(props.existingSeries ? props.existingSeries : emptySeries);
  const [submitting, setSubmitting] = useState(false);
  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });
  const overFlowBehaviorOptions: {
    [key in OverflowBehaviorType]: string;
  } = {
    ERROR: 'Error',
    CREATENEWLIST: 'Create New List',
    REMOVEOLDEST: 'Remove Oldest',
  };
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
    if (submitting) {
      return;
    }
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
    <PopUp
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
            newSeries.images.length === 0 ||
            submitting
          }
          onClick={async () => {
            setSubmitting(true);
            try {
              if (props.existingSeries) {
                if (newSeries.subsplashId) {
                  // edit subsplash list
                  const editSubsplashList = createFunctionV2<EditSubsplashListInputType, EditSubsplashListOutputType>(
                    'editsubsplashlist'
                  );

                  await editSubsplashList({
                    listId: newSeries.subsplashId,
                    title: newSeries.name,
                    images: newSeries.images,
                  });
                }
                const seriesRef = doc(firestore, 'series', newSeries.id);
                await updateDoc(seriesRef, {
                  ...newSeries,
                });
                if (props.setSeriesArray) {
                  props.setSeriesArray((oldSeriesArray) =>
                    oldSeriesArray.map((s) => {
                      if (s.id === newSeries.id) {
                        return { ...newSeries };
                      }
                      return s;
                    })
                  );
                }
                props.setNewSeriesPopup(false);
                setUserHasTypedInSeries(false);
              } else {
                const newSeriesId = await addNewSeries(newSeries);
                const seriesToAdd: Series = {
                  id: newSeriesId,
                  name: newSeries.name,
                  count: newSeries.count,
                  overflowBehavior: newSeries.overflowBehavior,
                  images: newSeries.images,
                };

                props.setNewSeriesPopup(false);
                if (props.setSeriesArray) {
                  props.setSeriesArray((previousseriesArray) => [seriesToAdd, ...previousseriesArray]);
                }
                if (props.setSermonSeries) {
                  props.setSermonSeries((previousSeries) => [seriesToAdd, ...previousSeries]);
                }
                setNewSeries(emptySeries);
                setUserHasTypedInSeries(false);
              }
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(error);
              setNewSeriesError({ error: true, message: JSON.stringify(error) });
            }
            setSubmitting(false);
          }}
        >
          {submitting ? <CircularProgress size={24} /> : 'Submit'}
        </Button>
      }
    >
      <Box display="flex" padding="10px" justifyContent="center" flexDirection="column" gap={1}>
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
        <FormControl fullWidth>
          <InputLabel id="overflow-behavior-select-label">Overflow Behavior</InputLabel>
          <Select
            value={newSeries.overflowBehavior}
            label="Overflow Behavior"
            labelId="overflow-behavior-select-label"
            id="overflow-behavior-select"
            onChange={(e) => {
              setNewSeries((oldSeries) => {
                return { ...oldSeries, overflowBehavior: e.target.value as OverflowBehaviorType };
              });
            }}
          >
            {OverflowBehavior.map((overflowBehavior) => {
              return (
                <MenuItem key={overflowBehavior} value={overflowBehavior}>
                  {overFlowBehaviorOptions[overflowBehavior]}
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
        <ImageViewer images={newSeries.images} newImageCallback={handleNewImage} vertical={false} />
      </Box>
    </PopUp>
  );
};

export default NewSeriesPopup;
