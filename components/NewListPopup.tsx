import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import firestore from '../firebase/firestore';
import { doc, updateDoc } from 'firebase/firestore';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
// import addNewList from '../api/addNewList';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import isEqual from 'lodash/isEqual';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import PopUp from './PopUp';
import { CircularProgress } from '@mui/material';
import { EditSubsplashListInputType, EditSubsplashListOutputType } from '../functions/src/editSubsplashList';
import { createFunctionV2 } from '../utils/createFunction';
import { createEmptyList, emptyList, List, ListType, OverflowBehavior } from '../types/List';

interface NewListPopupProps {
  newListPopup: boolean;
  setNewListPopup: Dispatch<SetStateAction<boolean>>;
  listArray: List[];
  setListArray?: Dispatch<SetStateAction<List[]>>;
  setSermonList?: Dispatch<SetStateAction<List[]>>;
  existingList?: List | undefined;
  listType?: ListType;
}

export const listTypeOptions: {
  [key in ListType]: string;
} = {
  [ListType.SERIES]: 'Series',
  [ListType.SPEAKER_LIST]: 'Speaker List',
  [ListType.TOPIC_LIST]: 'Topic',
  [ListType.CATEGORY_LIST]: 'Category',
  [ListType.LATEST]: 'Latest',
};

const NewListPopup = (props: NewListPopupProps) => {
  // TODO[0]: Make empty list without any specified list type if listtype is not passed in
  const [newList, setNewList] = useState<List>(
    props.existingList ? props.existingList : createEmptyList(props.listType || ListType.SERIES)
  );
  const [selectedOverflowBehavior, setSelectedOverflowBehavior] = useState<OverflowBehavior>(
    OverflowBehavior.CREATENEWLIST
  );

  const [submitting, setSubmitting] = useState(false);
  const [newListError, setNewListError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });
  const overFlowBehaviorOptions: {
    [key in OverflowBehavior]: string;
  } = {
    [OverflowBehavior.ERROR]: 'Error',
    [OverflowBehavior.CREATENEWLIST]: 'Create New List',
    [OverflowBehavior.REMOVEOLDEST]: 'Remove Oldest',
  };
  const [userHasTypedInList, setUserHasTypedInList] = useState<boolean>(false);
  useEffect(() => {
    if (props.existingList && newList.id !== props.existingList.id) {
      setNewList(props.existingList);
    }
  }, [props.existingList, newList]);

  const handleNewImage = (image: ImageType | ImageSizeType) => {
    setNewList((oldList) => {
      // check if image is ImageType or ImageSizeType
      if (isImageType(image)) {
        const castedImage = image as ImageType;
        let newImages: ImageType[] = [];
        if (oldList.images.find((img) => img.type === castedImage.type)) {
          newImages = oldList.images.map((img) => (img.type === castedImage.type ? castedImage : img));
        } else {
          newImages = [...oldList.images, castedImage];
        }
        return {
          ...oldList,
          images: newImages,
        };
      } else {
        const imageSizeType = image as ImageSizeType;
        return {
          ...oldList,
          images: oldList.images.filter((img) => img.type !== imageSizeType),
        };
      }
    });
  };

  useEffect(() => {
    if (submitting) {
      return;
    }
    if (!userHasTypedInList) {
      setNewListError({ error: false, message: '' });
      return;
    }
    if (newList?.name === '') {
      setNewListError({ error: true, message: 'List cannot be empty' });
    } else if (
      newList?.name &&
      props.listArray.map((list) => list.name.toLowerCase()).includes(newList.name.toLowerCase())
    ) {
      setNewListError({ error: true, message: 'List already exists' });
    } else {
      setNewListError({ error: false, message: '' });
    }
  }, [newList, userHasTypedInList, props.listArray]);

  return (
    <PopUp
      title={props.existingList ? `Edit ${props.existingList.name}` : `Add new ${props.listType || 'list'}`}
      open={props.newListPopup}
      setOpen={props.setNewListPopup}
      onClose={() => {
        setUserHasTypedInList(false);
        setNewList(emptyList);
      }}
      button={
        <Button
          variant="contained"
          disabled={
            (props.listArray.map((list) => list.name.toLowerCase()).includes(newList.name.toLowerCase()) &&
              isEqual(props.existingList?.images, newList.images)) ||
            newList.name === '' ||
            newList.images.length === 0 ||
            submitting
          }
          onClick={async () => {
            setSubmitting(true);
            try {
              if (props.existingList) {
                if (newList.subsplashId) {
                  // edit subsplash list
                  const editSubsplashList = createFunctionV2<EditSubsplashListInputType, EditSubsplashListOutputType>(
                    'editsubsplashlist'
                  );

                  await editSubsplashList({
                    listId: newList.subsplashId,
                    title: newList.name,
                    images: newList.images,
                  });
                }
                const listRef = doc(firestore, 'lists', newList.id);
                await updateDoc(listRef, {
                  ...newList,
                });
                if (props.setListArray) {
                  props.setListArray((oldListArray) =>
                    oldListArray.map((s) => {
                      if (s.id === newList.id) {
                        return { ...newList };
                      }
                      return s;
                    })
                  );
                }
                props.setNewListPopup(false);
                setUserHasTypedInList(false);
              } else {
                // const newListId = await addNewList(newList);
                // const listToAdd: List = {
                //   ...newList,
                //   id: newListId,
                // // };

                // props.setNewListPopup(false);
                // if (props.setListArray) {
                //   props.setListArray((previouslistArray) => [listToAdd, ...previouslistArray]);
                // }
                // if (props.setSermonList) {
                //   props.setSermonList((previousList) => [listToAdd, ...previousList]);
                // }
                // setNewList(emptyList);
                // setUserHasTypedInList(false);
                alert('Not implemented');
              }
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(error);
              setNewListError({ error: true, message: JSON.stringify(error) });
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
          value={newList.name}
          onChange={(e) => {
            setNewList((oldList) => {
              return { ...oldList, name: e.target.value };
            });
            !userHasTypedInList && setUserHasTypedInList(true);
          }}
          error={newListError.error}
          label={newListError.error ? newListError.message : 'Name'}
          sx={{ paddingBottom: '5px' }}
        />
        <FormControl fullWidth>
          <InputLabel id="overflow-behavior-select-label">Overflow Behavior</InputLabel>
          <Select
            value={selectedOverflowBehavior}
            label="Overflow Behavior"
            labelId="overflow-behavior-select-label"
            id="overflow-behavior-select"
            onChange={(e) => {
              setSelectedOverflowBehavior(e.target.value as OverflowBehavior);
            }}
          >
            {(Object.keys(OverflowBehavior) as Array<keyof typeof OverflowBehavior>).map((overflowBehavior) => {
              return (
                <MenuItem key={overflowBehavior} value={overflowBehavior}>
                  {overFlowBehaviorOptions[overflowBehavior]}
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
        {!props.listType && (
          <FormControl fullWidth>
            <InputLabel id="list-type-select-label" required>
              List Type
            </InputLabel>
            <Select
              value={newList.type}
              label="List Type"
              labelId="list-type-select-label"
              id="list-type-select"
              onChange={(e) => {
                setNewList((oldList) => ({ ...oldList, type: e.target.value as ListType }));
              }}
            >
              {/* eslint-disable-next-line array-callback-return */}
              {(Object.values(ListType) as Array<ListType>).map((listType) => {
                if (listType !== ListType.LATEST) {
                  return (
                    <MenuItem key={listType} value={listType}>
                      {listTypeOptions[listType]}
                    </MenuItem>
                  );
                }
              })}
            </Select>
          </FormControl>
        )}
        <ImageViewer images={newList.images} newImageCallback={handleNewImage} vertical={false} />
      </Box>
    </PopUp>
  );
};

export default NewListPopup;
