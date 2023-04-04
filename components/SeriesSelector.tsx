import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewSeriesPopup from './NewSeriesPopup';
import firestore, { query, collection, getDocs, where } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight } from '../types/List';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
}

const ListSelector: FunctionComponent<ListSelectorProps> = ({ sermonList, setSermonList }: ListSelectorProps) => {
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [allListArray, setAllListArray] = useState<ListWithHighlight[]>([]);

  const updateSermonList = (listWithHighlight: ListWithHighlight[]) => {
    const listArray: List[] = listWithHighlight.map((s) => {
      if ('_highlightResult' in s) {
        const { _highlightResult, ...list } = s;
        return list as List;
      }
      return s as List;
    });
    setSermonList(listArray);
  };

  useEffect(() => {
    const fetchList = async () => {
      const listQuery = query(collection(firestore, 'lists'), where('type', '==', ListType.SERIES)).withConverter(
        listConverter
      );
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
          value={sermonList}
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
                  updateSermonList(sermonList.filter((s) => s.id !== list.id));
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
          renderInput={(params) => <TextField {...params} label="List" />}
        />
        <IconButton
          size="small"
          sx={{ flexShrink: 0 }}
          onClick={() => {
            setNewSeriesPopup(true);
          }}
        >
          <AddIcon />
        </IconButton>
      </Box>
      <NewSeriesPopup
        newSeriesPopup={newSeriesPopup}
        setNewSeriesPopup={setNewSeriesPopup}
        listArray={allListArray}
        setListArray={setAllListArray}
        setSermonList={setSermonList}
      />
    </>
  );
};

export default ListSelector;
