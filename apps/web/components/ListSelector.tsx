import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect, useMemo, memo } from 'react';
import DOMPurify from 'dompurify';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import firestore, { query, collection, getDocs, where, limit, orderBy, startAfter, QueryConstraint, QueryDocumentSnapshot } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight } from '../types/List';
import { algoliasearch } from 'algoliasearch';
import { normalizeAlgoliaListHit, searchListsIndex, isDiscoverableRootList } from '../utils/algolia/searchRecords';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
  subtitle?: List;
}

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY)
    : undefined;

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
      const targetLimit = 5;
      const batchSize = 5; // Fetch in batches to handle filtering efficiently
      let allValidLists: List[] = [];
      let lastDoc: QueryDocumentSnapshot<List> | null = null;
      let hasMore = true;

      // Fetch batches until we have enough valid results or run out of documents
      while (allValidLists.length < targetLimit && hasMore) {
        const queryConstraints: QueryConstraint[] = [
          limit(batchSize),
          orderBy('updatedAtMillis', 'desc')
        ];
        
        if (props.listType) {
          queryConstraints.push(where('type', '==', props.listType));
        }
        
        // Use startAfter for pagination if we have a last document
        if (lastDoc) {
          queryConstraints.push(startAfter(lastDoc));
        }

        const listQuery = query(collection(firestore, 'lists'), ...queryConstraints).withConverter(listConverter);
        const listQuerySnapshot = await getDocs(listQuery);
        
        if (listQuerySnapshot.empty) {
          hasMore = false;
          break;
        }

        const validLists = listQuerySnapshot.docs
          .map((doc) => doc.data())
          .filter(isDiscoverableRootList);

        // Add to our collection, avoiding duplicates
        const existingIds = new Set(allValidLists.map(l => l.id));
        const newLists = validLists.filter(list => !existingIds.has(list.id));
        allValidLists = [...allValidLists, ...newLists].slice(0, targetLimit);

        // Update lastDoc for pagination
        lastDoc = listQuerySnapshot.docs[listQuerySnapshot.docs.length - 1];
        
        // If we got fewer documents than batchSize, we've reached the end
        if (listQuerySnapshot.docs.length < batchSize) {
          hasMore = false;
        }
      }

      setAllListArray(allValidLists.slice(0, targetLimit));
    };
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queryAlgolia = async (query: string): Promise<ListWithHighlight[]> => {
    if (client) {
      try {
        const result = await searchListsIndex(client, {
          query,
          hitsPerPage: 5,
          page: 0,
          sortProperty: 'name',
          sortOrder: 'asc',
          listType: props.listType ?? '',
        });
        return result.hits.map((hit) => ({
          ...normalizeAlgoliaListHit(hit),
          _highlightResult: (hit as ListWithHighlight)._highlightResult,
        }));
      } catch (error) {
        console.error('Search error:', error);
        return [];
      }
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
          onChange={async (_, newValue, reason) => {
            if (props.listType === ListType.CATEGORY_LIST && newValue.length > 1) {
              newValue = newValue.slice(1);
            }
            updateSermonList(newValue);
            if (reason === 'clear' && props.listType === ListType.SERIES && props.subtitle !== undefined) {
              props.setSermonList((oldSermonList) => [...oldSermonList, props.subtitle!]);
            }
          }}
          id={`${props.listType}-list-selector-input`}
          options={getListUnion(value, allListArray)}
          renderTags={(list, getTagProps) => {
            return list.map((list, index) => {
              const { key: _tagKey, ...tagProps } = getTagProps({ index });
              return (
                <Chip
                  {...tagProps}
                  key={list.id}
                  label={list.name}
                  onDelete={() => {
                    updateSermonList(props.sermonList.filter((s) => s.id !== list.id));
                    if (
                      props.sermonList.filter((list) => list.type === ListType.SERIES).length === 1 &&
                      props.listType === ListType.SERIES &&
                      props.subtitle !== undefined
                    ) {
                      props.setSermonList((oldSermonList) => [...oldSermonList, props.subtitle!]);
                    }
                  }}
                  sx={{ mr: 0.5, mb: 0.5 }}
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
              );
            });
          }}
          onInputChange={async (_, newInputValue) => {
            setAllListArray(await queryAlgolia(newInputValue));
          }}
          renderOption={(props, option: ListWithHighlight) => {
            const { key: _key, ...optionProps } = props;
            return (
            <ListItem key={option.id} {...optionProps}>
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
                                  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(option._highlightResult.name.value) }}></div>
              ) : (
                <div>{option.name}</div>
              )}
            </ListItem>
            );
          }}
          getOptionLabel={(option: ListWithHighlight) => option.name}
          isOptionEqualToValue={(option, value) =>
            value.name === undefined || option.name === undefined || option.id === value.id
          }
          renderInput={(params) => (
            <TextField
              {...params}
              required={props.listType === ListType.CATEGORY_LIST}
              label={
                props.listType
                  ? props.listType.charAt(0).toUpperCase() + props.listType.split('-')[0].slice(1)
                  : 'Lists'
              }
            />
          )}
        />
        {props.listType !== ListType.CATEGORY_LIST && (
          <IconButton
            size="small"
            sx={{ flexShrink: 0 }}
            onClick={() => {
              setNewListPopup(true);
            }}
          >
            <AddIcon />
          </IconButton>
        )}
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

export default memo(ListSelector);
