import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import {
  Fragment,
  FunctionComponent,
  Dispatch,
  SetStateAction,
  useState,
  useEffect,
  useMemo,
  memo,
  useRef,
  useCallback,
} from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import firestore, {
  query,
  collection,
  getDocs,
  where,
  limit,
  orderBy,
  QueryConstraint,
  startAfter,
  QueryDocumentSnapshot,
} from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight } from '../types/List';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import algoliasearch from 'algoliasearch';
import CircularProgress from '@mui/material/CircularProgress';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
  subtitle?: List;
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
  const [open, setOpen] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const lastDoc = useRef<QueryDocumentSnapshot<List> | null>(null);
  const loading = open && isQuerying;

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
  const fetchList = useCallback(async () => {
    setIsQuerying(true);
    const queryConstraints: QueryConstraint[] = [orderBy('name', 'asc'), startAfter(lastDoc.current), limit(15)];
    if (props.listType) {
      queryConstraints.push(where('type', '==', props.listType));
    }
    const listQuery = query(collection(firestore, 'lists'), ...queryConstraints).withConverter(listConverter);
    const listQuerySnapshot = await getDocs(listQuery);
    if (listQuerySnapshot.docs.length > 0) {
      lastDoc.current = listQuerySnapshot.docs[listQuerySnapshot.docs.length - 1];
    }
    setAllListArray((existingList) => {
      return [...existingList, ...listQuerySnapshot.docs.map((doc) => doc.data())];
    });
    setIsQuerying(false);
  }, [props.listType]);

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queryAlgolia = async (query: string) => {
    if (listIndex) {
      setIsQuerying(true);
      const result = await listIndex.search<ListWithHighlight>(query, {
        hitsPerPage: 5,
        ...(props.listType && { facetFilters: `type:${props.listType}` }),
      });
      setIsQuerying(false);
      return result.hits;
    }
    return [];
  };

  const value: List[] = useMemo(() => {
    return props.listType ? props.sermonList.filter((list) => list.type === props.listType) : props.sermonList;
  }, [props.listType, props.sermonList]);

  const getListUnion = (array1: ListWithHighlight[], array2: ListWithHighlight[]) => {
    const difference = array1.filter((s1) => !array2.find((s2) => s1.id === s2.id));
    return [...difference, ...array2].sort((a, b) => (a.name < b.name ? -1 : 1));
  };

  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          multiple
          fullWidth
          value={value}
          onOpen={() => {
            setOpen(true);
          }}
          onClose={() => {
            setOpen(false);
          }}
          loading={loading}
          loadingText="Loading..."
          onChange={async (_, newValue, reason) => {
            if (props.listType === ListType.CATEGORY_LIST && newValue.length > 1) {
              newValue = newValue.slice(1);
            }
            updateSermonList(newValue);
            if (reason === 'clear' && props.listType === ListType.SERIES && props.subtitle !== undefined) {
              props.setSermonList((oldSermonList) => [...oldSermonList, props.subtitle!]);
            }
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
                  if (
                    props.sermonList.filter((list) => list.type === ListType.SERIES).length === 1 &&
                    props.listType === ListType.SERIES &&
                    props.subtitle !== undefined
                  ) {
                    props.setSermonList((oldSermonList) => [...oldSermonList, props.subtitle!]);
                  }
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
            <>
              <ListItem {...props} key={option.id}>
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
            </>
          )}
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
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <Fragment>
                    {loading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </Fragment>
                ),
              }}
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
