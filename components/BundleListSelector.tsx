import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect, useMemo, memo } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewListPopup from './NewListPopup';
import firestore, { query, collection, getDocs, where, limit, orderBy, QueryConstraint } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import { List, listConverter, ListType, ListWithHighlight, OverflowBehavior } from '../types/List';
import { BundleManager } from '../utils/bundleManager';
import { TOPIC_BUNDLE_CONFIG, SUBTITLE_BUNDLE_CONFIG } from '../utils/bundleConfigs';
import { LocalSearch } from '../utils/localSearch';
import { Topic } from '../types/Topic';

// Conditionally import Algolia only if not using topic lists and API keys are available
let algoliaClient: any = null;
let listIndex: any = null;

if (process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY) {
  try {
    import('algoliasearch').then(({ default: algoliasearch }) => {
      import('@algolia/cache-in-memory').then(({ createInMemoryCache }) => {
        algoliaClient = algoliasearch(
          process.env.NEXT_PUBLIC_ALGOLIA_APP_ID!,
          process.env.NEXT_PUBLIC_ALGOLIA_API_KEY!,
          {
            responsesCache: createInMemoryCache(),
            requestsCache: createInMemoryCache({ serializable: false }),
          }
        );
        listIndex = algoliaClient.initIndex('lists');
      });
    });
  } catch (error) {
    console.warn('Algolia not available:', error);
  }
}

interface BundleListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
  subtitle?: List;
}

const BundleListSelector: FunctionComponent<BundleListSelectorProps> = (props: BundleListSelectorProps) => {
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [allListArray, setAllListArray] = useState<ListWithHighlight[]>([]);
  const [localTopicSearch, setLocalTopicSearch] = useState<LocalSearch<Topic> | null>(null);
  const [localSubtitleSearch, setLocalSubtitleSearch] = useState<LocalSearch<List> | null>(null);
  const [isLoadingBundles, setIsLoadingBundles] = useState<boolean>(false);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Configuration constants for better scrolling
  const SEARCH_RESULTS_LIMIT = 50;  // Show more search results
  const MAX_DROPDOWN_HEIGHT = 300;  // Max height for scrollable dropdown

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

  // Convert Topic to ListWithHighlight for compatibility
  const topicToListWithHighlight = (topic: Topic): ListWithHighlight => ({
    id: topic.id,
    name: topic.title,
    type: ListType.TOPIC_LIST,
    images: topic.images,
    count: topic.itemsCount,
    createdAtMillis: topic.createdAtMillis,
    updatedAtMillis: topic.updatedAtMillis,
    overflowBehavior: OverflowBehavior.CREATENEWLIST
  });

  useEffect(() => {
    const fetchList = async () => {
      // For topic lists, use topic bundles
      if (props.listType === ListType.TOPIC_LIST) {
        setIsLoadingBundles(true);
        try {
          console.log('Loading topics from bundle...');
          const bundleManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
          const topics = await bundleManager.getData();
          
          console.log(`Loaded ${topics.length} topics from bundle`);
          
          // Convert topics to the format expected by ListSelector
          const topicLists = topics.map(topicToListWithHighlight);
          setAllListArray(topicLists);
          
          // Initialize local search
          const searchInstance = new LocalSearch(topics, 'title', 'topics');
          setLocalTopicSearch(searchInstance);
          
        } catch (error) {
          console.error('Error loading topics from bundle:', error);
          // Fallback to regular Firestore query
          console.log('Falling back to regular Firestore query for topics');
          await fetchRegularList();
        } finally {
          setIsLoadingBundles(false);
        }
      }
      // For category lists (subtitles), use subtitle bundles
      else if (props.listType === ListType.CATEGORY_LIST) {
        setIsLoadingBundles(true);
        try {
          console.log('Loading subtitles from bundle...');
          const bundleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
          const subtitles = await bundleManager.getData();
          
          console.log(`Loaded ${subtitles.length} subtitles from bundle`);
          
          setAllListArray(subtitles);
          
          // Initialize local search for subtitles
          const searchInstance = new LocalSearch(subtitles, 'name', 'subtitles');
          setLocalSubtitleSearch(searchInstance);
          
        } catch (error) {
          console.error('Error loading subtitles from bundle:', error);
          // Fallback to regular Firestore query
          console.log('Falling back to regular Firestore query for subtitles');
          await fetchRegularList();
        } finally {
          setIsLoadingBundles(false);
        }
      } else {
        await fetchRegularList();
      }
    };

    const fetchRegularList = async () => {
      const queryConstraints: QueryConstraint[] = [orderBy('title', 'asc')];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.listType]);

  const queryAlgolia = async (query: string): Promise<ListWithHighlight[]> => {
    try {
      if (!listIndex) {
        console.warn('Algolia not initialized, using empty results');
        return [];
      }
      
      const result = await listIndex.search(query, {
        hitsPerPage: SEARCH_RESULTS_LIMIT,
        ...(props.listType && { facetFilters: `type:${props.listType}` }),
      });
      return result.hits || [];
    } catch (error) {
      console.error('Error querying Algolia:', error);
      return [];
    }
  };

  const searchTopicsLocally = async (query: string): Promise<ListWithHighlight[]> => {
    try {
      if (!localTopicSearch || !query.trim()) {
        // Return more initial topics if no query
        const bundleManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
        const topics = await bundleManager.getData();
        return topics.map(topicToListWithHighlight);
      }

      console.log(`Searching topics locally for: "${query}"`);
      const searchResults = localTopicSearch.search(query, SEARCH_RESULTS_LIMIT);
      console.log(`Found ${searchResults.length} topic results`);
      
      return searchResults.map(result => topicToListWithHighlight(result.item));
    } catch (error) {
      console.error('Error searching topics locally:', error);
      return [];
    }
  };

  const searchSubtitlesLocally = async (query: string): Promise<ListWithHighlight[]> => {
    try {
      if (!localSubtitleSearch || !query.trim()) {
        // Return more initial subtitles if no query
        const bundleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
        const subtitles = await bundleManager.getData();
        return subtitles;
      }

      console.log(`Searching subtitles locally for: "${query}"`);
      const searchResults = localSubtitleSearch.search(query, SEARCH_RESULTS_LIMIT);
      console.log(`Found ${searchResults.length} subtitle results`);
      
      return searchResults.map(result => result.item);
    } catch (error) {
      console.error('Error searching subtitles locally:', error);
      return [];
    }
  };

  const value: List[] = useMemo(() => {
    return props.listType ? props.sermonList.filter((list) => list.type === props.listType) : props.sermonList;
  }, [props.listType, props.sermonList]);

  const getListUnion = (array1: ListWithHighlight[], array2: ListWithHighlight[]) => {
    const difference = array1.filter((s1) => !array2.find((s2) => s1.id === s2.id));
    const combined = [...difference, ...array2];
    
    // Preserve search result order when searching, use alphabetical order when not searching
    if (isSearching) {
      return combined;
    } else {
      return combined.sort((a, b) => a.name.localeCompare(b.name));
    }
  };

  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          multiple
          fullWidth
          value={value}
          loading={isLoadingBundles}
          // Enhanced scrolling configuration
          ListboxProps={{
            style: {
              maxHeight: MAX_DROPDOWN_HEIGHT,
              overflow: 'auto',
            },
          }}
          // Show more options before scrolling
          limitTags={3}
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
            const hasQuery = newInputValue.trim().length > 0;
            setIsSearching(hasQuery);
            
            if (props.listType === ListType.TOPIC_LIST) {
              setAllListArray(await searchTopicsLocally(newInputValue));
            } else if (props.listType === ListType.CATEGORY_LIST) {
              setAllListArray(await searchSubtitlesLocally(newInputValue));
            } else {
              setAllListArray(await queryAlgolia(newInputValue));
            }
          }}
          renderOption={(props, option: ListWithHighlight) => (
            <ListItem {...props} key={option.id} dense>
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

export default memo(BundleListSelector); 