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
import AddIcon from '@mui/icons-material/Add';
import { List, ListType, ListWithHighlight, OverflowBehavior } from '../types/List';
import { BundleManager } from '../utils/bundleManager';
import { LocalSearch } from '../utils/localSearch';
import { Topic } from '../types/Topic';
import { TOPIC_BUNDLE_CONFIG } from '../shared/bundleConfigs';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import firestore, { collection, getDocs, query, where } from '../firebase/firestore';
import { isDiscoverableRootList } from '../utils/algolia/searchRecords';
import { listConverter } from '../types/List';

interface BundleListSelectorProps {
  sermonList: List[];
  setSermonList: Dispatch<SetStateAction<List[]>>;
  listType?: ListType;
  subtitle?: List;
  error?: UploaderFieldError;
  setError?: (error: boolean, message: string) => void;
}

const BundleListSelector: FunctionComponent<BundleListSelectorProps> = (props: BundleListSelectorProps) => {
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [allListArray, setAllListArray] = useState<ListWithHighlight[]>([]);
  const [visibleListArray, setVisibleListArray] = useState<ListWithHighlight[]>([]);
  const [localTopicSearch, setLocalTopicSearch] = useState<LocalSearch<Topic> | null>(null);
  const [isLoadingBundles, setIsLoadingBundles] = useState<boolean>(false);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Configuration constants for better scrolling
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
  const topicToListWithHighlight = (topic: Topic, resolvedList: List): ListWithHighlight => ({
    id: resolvedList.id,
    name: resolvedList.name,
    type: ListType.TOPIC_LIST,
    images: resolvedList.images,
    count: resolvedList.count ?? topic.itemsCount,
    logicalCount: resolvedList.logicalCount,
    hasOverflowPages: resolvedList.hasOverflowPages,
    createdAtMillis: resolvedList.createdAtMillis ?? topic.createdAtMillis,
    updatedAtMillis: resolvedList.updatedAtMillis ?? topic.updatedAtMillis,
    overflowBehavior: resolvedList.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
    subsplashId: resolvedList.subsplashId,
    moreSermonsRef: resolvedList.moreSermonsRef,
    isMoreSermonsList: resolvedList.isMoreSermonsList,
    isRootList: resolvedList.isRootList,
    rootListId: resolvedList.rootListId,
    overflowDepth: resolvedList.overflowDepth,
    listTagAndPosition: resolvedList.listTagAndPosition,
  });

  useEffect(() => {
    const fetchList = async () => {
      // For topic lists, use topic bundles
      if (props.listType === ListType.TOPIC_LIST) {
        setIsLoadingBundles(true);
        try {
          const bundleManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
          let topics = await bundleManager.getData();
          topics = topics.filter((topic) => topic.listId !== undefined);

          const topicListsSnapshot = await getDocs(
            query(collection(firestore, 'lists'), where('type', '==', ListType.TOPIC_LIST)).withConverter(listConverter)
          );
          const topicLists = topicListsSnapshot.docs
            .map((docSnapshot) => docSnapshot.data())
            .filter(isDiscoverableRootList);
          const listsByFirestoreId = new Map(topicLists.map((list) => [list.id, list]));
          const listsBySubsplashId = new Map(
            topicLists
              .filter((list): list is List & { subsplashId: string } => typeof list.subsplashId === 'string' && list.subsplashId.length > 0)
              .map((list) => [list.subsplashId, list])
          );
          const listsByName = new Map(topicLists.map((list) => [list.name.trim().toLowerCase(), list]));
         
          // Convert topics to the format expected by ListSelector
          const resolvedTopicLists = topics.flatMap((topic) => {
            const resolvedList =
              listsByFirestoreId.get(topic.listId!) ??
              listsBySubsplashId.get(topic.listId!) ??
              listsByName.get(topic.title.trim().toLowerCase()) ??
              null;
            if (!resolvedList) {
              console.warn('Skipping topic with unresolved Firestore list', {
                topicId: topic.id,
                topicTitle: topic.title,
                topicListId: topic.listId,
              });
              return [];
            }
            return [topicToListWithHighlight(topic, resolvedList)];
          });
          setAllListArray(resolvedTopicLists);
          setVisibleListArray(resolvedTopicLists);
          // Initialize local search
          const searchInstance = new LocalSearch(topics, 'title', 'topics');
          setLocalTopicSearch(searchInstance);
        } catch (error) {
          console.error('Error loading topics from bundle:', error);
        } finally {
          setIsLoadingBundles(false);
        }
      }
      // For category lists (subtitles), use subtitle bundles
      else {
        throw new Error('List type not supported');
       }  
    }
    fetchList();
  }, [props.listType]);

  const searchTopicsLocally = async (query: string): Promise<ListWithHighlight[]> => {
    try {
      if (!localTopicSearch || !query.trim()) {
        return allListArray;
      }
      const searchResults = localTopicSearch.search(query);
      const resolvedByLegacyId = new Map(allListArray.map((list) => [list.subsplashId ?? list.id, list]));
      return searchResults.map((result) => {
        const topic = result.item;
        return resolvedByLegacyId.get(topic.listId ?? topic.id);
      }).filter((list): list is ListWithHighlight => Boolean(list));
    } catch (error) {
      console.error('Error searching topics locally:', error);
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
          onBlur={() => {
            // Mark field as touched for error display
            if (props.setError && props.listType === ListType.TOPIC_LIST) {
              const hasTopics = value.length > 0;
              props.setError(!hasTopics, hasTopics ? '' : 'You must select at least one topic');
            }
          }}
          onChange={async (_, newValue, reason) => {
            if (props.listType === ListType.CATEGORY_LIST && newValue.length > 1) {
              newValue = newValue.slice(1);
            }
            updateSermonList(newValue);
            if (reason === 'clear' && props.listType === ListType.SERIES && props.subtitle !== undefined) {
              props.setSermonList((oldSermonList) => [...oldSermonList, props.subtitle!]);
            }
          }}
          id="bundle-list-selector-input"
          options={getListUnion(value, visibleListArray)}
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
            const hasQuery = newInputValue.trim().length > 0;
            setIsSearching(hasQuery);
            setVisibleListArray(await searchTopicsLocally(newInputValue));
          }}
          renderOption={(props, option: ListWithHighlight) => {
            const { key: _key, ...optionProps } = props;
            return (
            <ListItem key={option.id} {...optionProps} dense>
              <AvatarWithDefaultImage
                defaultImageURL="/user.png"
                altName={option.name}
                width={30}
                height={30}
                image={option.images?.find((image) => image.type === 'square')}
                borderRadius={5}
                sx={{ marginRight: '15px' }}
              />
              {option._highlightResult ? (
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
              required={props.listType === ListType.TOPIC_LIST}
              error={showError(props.error)}
              helperText={getErrorMessage(props.error)}
              label={
                props.listType
                  ? props.listType.charAt(0).toUpperCase() + props.listType.split('-')[0].slice(1)
                  : 'Lists'
              }
            />
          )}
        />
        {(props.listType !== ListType.CATEGORY_LIST && props.listType !== ListType.TOPIC_LIST) && (
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
        setListArray={setVisibleListArray}
        setSermonList={props.setSermonList}
        listType={props.listType}
      />
    </>
  );
};

export default memo(BundleListSelector); 
