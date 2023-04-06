import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import firestore, { query, collection, getDocs, where, limit } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight } from '../types/List';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
}

const ListSelector: FunctionComponent<ListSelectorProps> = (props: ListSelectorProps) => {
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [allListArray, setAllListArray] = useState<ListWithHighlight[]>([]);

  const updateSermonList = (listWithHighlight: ListWithHighlight[]) => {
    const listArray: List[] = listWithHighlight.map((s) => {
      if ('_highlightResult' in s) {
        const { _highlightResult, ...list } = s;
        return list as List;
      }
      return s as List;
    });
    if (!props.listType) {
      props.setSermonList(listArray);
    } else {
      if (props.listType === ListType.SERIES) {
        // also removes category lists
        props.setSermonList((oldSermonList) => [
          ...oldSermonList.filter((list) => list.type !== props.listType && list.type !== ListType.CATEGORY_LIST),
          ...listArray.filter((list) => list.type === props.listType),
        ]);
      } else {
        // Only updates of items of input listtype
        props.setSermonList((oldSermonList) => [
          ...oldSermonList.filter((list) => list.type !== props.listType),
          ...listArray.filter((list) => list.type === props.listType),
        ]);
      }
    }
  };

  useEffect(() => {
    const fetchList = async () => {
      // TODO[1]: Query from algolia!!!!
      const listQuery = props.listType
        ? query(collection(firestore, 'lists'), where('type', '==', props.listType)).withConverter(listConverter)
        : query(collection(firestore, 'lists'), limit(5)).withConverter(listConverter);
      const listQuerySnapshot = await getDocs(listQuery);
      setAllListArray(
        listQuerySnapshot.docs.map((doc) => {
          const list = doc.data();
          return list;
        })
      );
    };
    fetchList();
  }, []);
  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          multiple
          fullWidth
          value={props.listType ? props.sermonList.filter((list) => list.type === props.listType) : props.sermonList}
          onChange={async (_, newValue) => {
            updateSermonList(newValue);
          }}
          id="list-input"
          options={allListArray}
          renderTags={(list, _) => {
            return list.map((list) => (
              <Chip
                key={list.id}
                label={list.name}
                onDelete={() => {
                  updateSermonList(props.sermonList.filter((s) => s.id !== list.id));
                }}
                avatar={
                  <AvatarWithDefaultImage
                    defaultImageURL="/user.png"
                    altName={list.name}
                    width={24}
                    height={24}
                    borderRadius={12}
                    image={list.images?.find((image) => image.type === 'square')}
                  />
                }
              />
            ));
          }}
          renderOption={(props, option: ListWithHighlight) => (
            <ListItem key={option.id} {...props}>
              <AvatarWithDefaultImage
                defaultImageURL="/user.png"
                altName={option.name}
                width={30}
                height={30}
                image={option.images?.find((image) => image.type === 'square')}
                borderRadius={5}
                sx={{ marginRight: '15px' }}
              />
              {option._highlightResult && allListArray.find((s) => s.id === option?.id) === undefined ? (
                <div dangerouslySetInnerHTML={{ __html: sanitize(option._highlightResult.name.value) }}></div>
              ) : (
                <div>{option.name}</div>
              )}
            </ListItem>
          )}
          getOptionLabel={(option: ListWithHighlight) => option.name}
          isOptionEqualToValue={(option, value) =>
            value.name === undefined ||
            option.name === undefined ||
            (option.name === value.name && option.id === value.id)
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label={props.listType ? props.listType.charAt(0).toUpperCase() + props.listType.split('-')[0].slice(1) : 'Lists'}
            />
          )}
        />
        <IconButton
          size="small"
          sx={{ flexShrink: 0 }}
          onClick={() => {
            setNewListPopup(true);
          }}
        >
          <AddIcon />
        </IconButton>
      </Box>
      <NewListPopup
        newListPopup={newListPopup}
        setNewListPopup={setNewListPopup}
        listArray={allListArray}
        setListArray={setAllListArray}
        setSermonList={props.setSermonList}
        listType={props.listType}
      />
    </>
  );
};

export default ListSelector;
