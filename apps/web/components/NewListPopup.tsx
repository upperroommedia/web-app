import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import firestore from '../firebase/firestore';
import { doc, updateDoc } from 'firebase/firestore';
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';
import addNewList from '../utils/addNewList';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import PopUp from './PopUp';
import CircularProgress from '@mui/material/CircularProgress';
import { EditSubsplashListInputType, EditSubsplashListOutputType } from '../functions/src/editSubsplashList';
import { createFunctionV2 } from '../utils/createFunction';
import { createEmptyList, emptyList, List, ListType, OverflowBehavior } from '../types/List';

// Custom utility function to compare arrays of ImageType objects
const areImageArraysEqual = (arr1?: ImageType[], arr2?: ImageType[]): boolean => {
  if (!arr1 && !arr2) return true;
  if (!arr1 || !arr2) return false;
  if (arr1.length !== arr2.length) return false;

  // Sort both arrays by type and id for consistent comparison
  const sorted1 = [...arr1].sort((a, b) => `${a.type}-${a.id}`.localeCompare(`${b.type}-${b.id}`));
  const sorted2 = [...arr2].sort((a, b) => `${a.type}-${a.id}`.localeCompare(`${b.type}-${b.id}`));

  return sorted1.every((img1, index) => {
    const img2 = sorted2[index];
    return (
      img1.id === img2.id &&
      img1.type === img2.type &&
      img1.downloadLink === img2.downloadLink &&
      img1.name === img2.name
    );
  });
};

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
  const [newList, setNewList] = useState<List>(
    props.existingList ? props.existingList : createEmptyList(props.listType || ListType.SERIES)
  );

  const [submitting, setSubmitting] = useState(false);
  const [submitErrorMessage, setSubmitErrorMessage] = useState('');
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
      queueMicrotask(() => {
        setNewList(props.existingList ?? emptyList);
      });
    }
  }, [props.existingList, newList]);

  const handleNewImage = useCallback(
    (image: ImageType | ImageSizeType) => {
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
    },
    [setNewList]
  );

  const validationErrorMessage = useMemo(() => {
    if (submitting || !userHasTypedInList) {
      return '';
    }
    if (newList.name === '') {
      return 'List cannot be empty';
    }
    const lowerCaseListNames = props.listArray.map((list) => list.name.toLowerCase());
    if (newList.name && lowerCaseListNames.includes(newList.name.toLowerCase())) {
      return 'List already exists';
    }
    return '';
  }, [newList.name, props.listArray, submitting, userHasTypedInList]);

  const newListError = useMemo(
    () => ({
      error: submitErrorMessage.length > 0 || validationErrorMessage.length > 0,
      message: submitErrorMessage || validationErrorMessage,
    }),
    [submitErrorMessage, validationErrorMessage]
  );

  return (
    <PopUp
      title={props.existingList ? `Edit ${props.existingList.name}` : `Add new ${props.listType || 'list'}`}
      open={props.newListPopup}
      setOpen={props.setNewListPopup}
      onClose={() => {
        setUserHasTypedInList(false);
        setSubmitErrorMessage('');
        setNewList(emptyList);
      }}
      button={
        <Button
          variant="contained"
          disabled={
            (props.listArray.map((list) => list.name.toLowerCase()).includes(newList.name.toLowerCase()) &&
              areImageArraysEqual(props.existingList?.images, newList.images)) ||
            newList.name === '' ||
            newList.images.length === 0 ||
            submitting
          }
          onClick={async () => {
            setSubmitting(true);
            setSubmitErrorMessage('');
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
                const newListId = await addNewList(newList);
                const listToAdd: List = {
                  ...newList,
                  id: newListId,
                };

                props.setNewListPopup(false);
                if (props.setListArray) {
                  props.setListArray((previouslistArray) => [listToAdd, ...previouslistArray]);
                }
                if (props.setSermonList) {
                  props.setSermonList((previousList) => [listToAdd, ...previousList]);
                }
                setNewList(emptyList);
                setUserHasTypedInList(false);
              }
            } catch (error) {
              console.error(error);
              setSubmitErrorMessage(JSON.stringify(error));
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
            if (!userHasTypedInList) {
              setUserHasTypedInList(true);
            }
            if (submitErrorMessage) {
              setSubmitErrorMessage('');
            }
          }}
          error={newListError.error}
          label={newListError.error ? newListError.message : 'Name'}
          sx={{ paddingBottom: '5px' }}
        />
        <FormControl fullWidth>
          <InputLabel id="overflow-behavior-select-label">Overflow Behavior</InputLabel>
          <Select
            value={newList.overflowBehavior}
            label="Overflow Behavior"
            labelId="overflow-behavior-select-label"
            id="overflow-behavior-select"
            onChange={(e) => {
              setNewList((oldList) => ({ ...oldList, overflowBehavior: e.target.value as OverflowBehavior }));
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
              {(Object.values(ListType) as Array<ListType>).map((listType) => {
                if (listType !== ListType.LATEST) {
                  return (
                    <MenuItem key={listType} value={listType}>
                      {listTypeOptions[listType]}
                    </MenuItem>
                  );
                }
                return null;
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
