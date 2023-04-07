import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect, useMemo } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import firestore, { query, collection, getDocs, where, limit, orderBy, QueryConstraint } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight } from '../types/List';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import algoliasearch from 'algoliasearch';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
}

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const listIndex = client?.initIndex('lists');

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
      const queryConstraints: QueryConstraint[] = [limit(5), orderBy('updatedAtMillis', 'desc')];
      if (props.listType) {
        queryConstraints.push(where('type', '==', props.listType));
      }
      const listQuery = query(collection(firestore, 'lists'), ...queryConstraints).withConverter(listConverter);
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

  const queryAlgolia = async (query: string) => {
    if (listIndex) {
      const result = await listIndex.search<ListWithHighlight>(query, {
        hitsPerPage: 5,
        ...(props.listType && { facetFilters: `type:${props.listType}` }),
      });
      return result.hits;
    }
    return [];
  };

  const value: List[] = useMemo(() => {
    return props.listType ? props.sermonList.filter((list) => list.type === props.listType) : props.sermonList;
  }, [props.listType, props.sermonList]);

  const getListUnion = (array1: ListWithHighlight[], array2: ListWithHighlight[]) => {
    const difference = array1.filter((s1) => !array2.find((s2) => s1.id === s2.id));
    return [...difference, ...array2].sort((a, b) => (a.name > b.name ? -1 : 1));
  };

  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          multiple
          fullWidth
          value={value}
          onChange={async (_, newValue) => {
            updateSermonList(newValue);
          }}
          id="list-input"
          options={getListUnion(value, allListArray)}
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
          onInputChange={async (_, newInputValue) => {
            setAllListArray(await queryAlgolia(newInputValue));
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
            value.name === undefined || option.name === undefined || option.id === value.id
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label={
                props.listType
                  ? props.listType.charAt(0).toUpperCase() + props.listType.split('-')[0].slice(1)
                  : 'Lists'
              }
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
