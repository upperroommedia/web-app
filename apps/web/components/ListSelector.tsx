import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect, useMemo, useRef, memo } from 'react';
import DOMPurify from 'dompurify';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import AddIcon from '@mui/icons-material/Add';
import { List, ListType, ListWithHighlight } from '../types/List';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { createBrowserSearchClient } from '../utils/algolia/browserSearch';
import { browseLists, type BrowsePage } from '../utils/algolia/browseRecords';
import { normalizeAlgoliaListHit, searchListsIndex } from '../utils/algolia/searchRecords';

interface ListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
  subtitle?: List;
}

const client = createBrowserSearchClient();

const ListSelector: FunctionComponent<ListSelectorProps> = (props: ListSelectorProps) => {
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [allListArray, setAllListArray] = useState<ListWithHighlight[]>([]);
  const [browsePage, setBrowsePage] = useState<BrowsePage<List>>();
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string>();
  const browseRevision = useRef(0);
  const browseInFlight = useRef<number | undefined>(undefined);
  const searchRevision = useRef(0);
  const loadMoreLists = async (reset = false) => {
    if (!reset && browseInFlight.current !== undefined) return;
    const revision = reset ? ++browseRevision.current : browseRevision.current;
    browseInFlight.current = revision;
    if (reset) {
      setAllListArray([]);
      setBrowsePage(undefined);
    }
    setBrowseLoading(true);
    setBrowseError(undefined);
    try {
      const page = await browseLists(props.listType, reset ? undefined : browsePage?.cursor);
      if (revision !== browseRevision.current) return;
      setBrowsePage(page);
      setAllListArray((previous) => [
        ...new Map([...(reset ? [] : previous), ...page.items].map((item) => [item.id, item])).values(),
      ]);
    } catch {
      if (revision === browseRevision.current) setBrowseError('Unable to load lists. Please try again.');
    } finally {
      if (revision === browseRevision.current) {
        browseInFlight.current = undefined;
        setBrowseLoading(false);
      }
    }
  };

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
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return loadMoreLists(true);
    });
    return () => {
      active = false;
      // These refs invalidate async requests; they do not hold DOM nodes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      browseRevision.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      searchRevision.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.listType]);

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
            if (client) {
              browseRevision.current++;
              browseInFlight.current = undefined;
              setBrowseLoading(false);
              const revision = ++searchRevision.current;
              const results = await queryAlgolia(newInputValue);
              if (revision === searchRevision.current) setAllListArray(results);
            }
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
                  <div
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(option._highlightResult.name.value) }}
                  ></div>
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
      {!client && (
        <Typography variant="caption">Search is unavailable. Filter the lists loaded below, or load more.</Typography>
      )}
      {browseError && <Typography color="error">{browseError}</Typography>}
      {!client && (browsePage?.hasMore || browseError) && (
        <Button disabled={browseLoading} onClick={() => void loadMoreLists()}>
          {browseError ? 'Retry loading lists' : 'Load more lists'}
        </Button>
      )}
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
