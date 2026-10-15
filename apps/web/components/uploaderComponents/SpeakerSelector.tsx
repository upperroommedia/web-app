import React, { Dispatch, SetStateAction, memo, useEffect, useRef, useState } from 'react';
import AvatarWithDefaultImage from '../AvatarWithDefaultImage';
import ListItem from '@mui/material/ListItem';
import { ISpeaker } from '../../types/Speaker';
import Autocomplete from '@mui/material/Autocomplete';
import { UploaderFieldError } from '../../context/types';
import firestore, { collection, doc, getDocFromServer, getDocs, query, where } from '../../firebase/firestore';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import { List, ListType, listConverter } from '../../types/List';
import DOMPurify from 'dompurify';
import { SearchClient, SearchResponse } from 'algoliasearch';
import { Sermon } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { getErrorMessage, showError } from './utils';
import { isDiscoverableRootList } from '../../utils/algolia/searchRecords';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import SearchAttribution from '../algoliaComponents/SearchAttribution';
import { browseSpeakers, type BrowsePage } from '../../utils/algolia/browseRecords';
import { applySpeakerImageDefaults, loadSpeakerImageDefaults } from '../../utils/speakerImageDefaults';

interface AlgoliaSpeaker extends ISpeaker {
  nbHits?: number;
  _highlightResult?: {
    name: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
  };
}

interface SpeakerSelectorProps {
  sermonSpeakers: ISpeaker[];
  sermonImages: ImageType[];
  setSermon: Dispatch<SetStateAction<Sermon>>;
  updateSermon: <T extends keyof Sermon>(key: T, value: Sermon[T]) => void;
  speakerError?: UploaderFieldError;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  setSpeakerError: (error: boolean, message: string) => void;
  showSpeakerRequestAction?: boolean;
  onOpenSpeakerRequest?: () => void;
}

export const fetchSpeakerResults = async (
  query: string,
  hitsPerPage: number,
  page: number,
  client: SearchClient | null
): Promise<AlgoliaSpeaker[]> => {
  if (client) {
    try {
      const response = await client.search<AlgoliaSpeaker>({
        requests: [
          {
            indexName: 'speakers',
            query,
            hitsPerPage,
            page,
          },
        ],
      });
      const speakerResults = response.results[0] as SearchResponse<AlgoliaSpeaker> | undefined;
      return speakerResults?.hits ?? [];
    } catch (error) {
      console.error('Search error:', error);
    }
  } else {
    console.warn('Algolia client not initialized. Returning empty speaker list.');
  }
  return [];
};

const getSpeakersUnion = (array1: AlgoliaSpeaker[], array2: AlgoliaSpeaker[]) => {
  const difference = array1.filter((s1) => !array2.find((s2) => s1.id === s2.id));
  return [...difference, ...array2].sort((a, b) => (a.name > b.name ? 1 : -1));
};

function SpeakerSelector({
  sermonSpeakers,
  sermonImages,
  setSermon,
  updateSermon,
  speakerError,
  setSermonList,
  setSpeakerError,
  showSpeakerRequestAction = false,
  onOpenSpeakerRequest,
}: SpeakerSelectorProps) {
  const { sharedSearchClient: client } = useAlgoliaSearch();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSearchRequestRef = useRef(0);
  const [speakersArray, setSpeakersArray] = useState<AlgoliaSpeaker[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [hasCompletedSearch, setHasCompletedSearch] = useState(false);
  const [browsePage, setBrowsePage] = useState<BrowsePage<ISpeaker>>();
  const [browseError, setBrowseError] = useState<string>();
  const browseInFlight = useRef(false);
  const imageSelection = useRef(0);
  const mounted = useRef(true);
  const [defaultImageWarning, setDefaultImageWarning] = useState<string>();
  const loadMoreSpeakers = async (reset = false) => {
    if (!reset && browseInFlight.current) return;
    browseInFlight.current = true;
    const revision = ++latestSearchRequestRef.current;
    setSearchLoading(true);
    setBrowseError(undefined);
    try {
      const page = await browseSpeakers(reset ? undefined : browsePage?.cursor);
      if (revision !== latestSearchRequestRef.current) return;
      setBrowsePage(page);
      setSpeakersArray((previous) => getSpeakersUnion(reset ? [] : previous, page.items));
    } catch {
      if (revision === latestSearchRequestRef.current) setBrowseError('Unable to load speakers. Please try again.');
    } finally {
      if (revision === latestSearchRequestRef.current) {
        browseInFlight.current = false;
        setSearchLoading(false);
        setHasCompletedSearch(true);
      }
    }
  };

  useEffect(() => {
    setSpeakersArray([]);
    setSearchInput('');
    browseInFlight.current = false;
    const fetchData = async () => {
      if (!client) {
        await loadMoreSpeakers(true);
        return;
      }
      setSearchLoading(true);
      const requestId = ++latestSearchRequestRef.current;
      const speakerResults = await fetchSpeakerResults('', 20, 0, client);
      if (requestId !== latestSearchRequestRef.current) {
        return;
      }
      setSpeakersArray(speakerResults);
      setSearchLoading(false);
      setHasCompletedSearch(true);
    };
    void fetchData();
    return () => {
      // This generation invalidates pending reads, rather than referencing a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latestSearchRequestRef.current++;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      imageSelection.current++;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return (
    <>
      {client && <SearchAttribution />}
      <Autocomplete
        fullWidth
        value={sermonSpeakers}
        onBlur={() => {
          if (sermonSpeakers.length === 0) {
            setSpeakerError(true, 'You must select at least one speaker');
          } else {
            setSpeakerError(false, '');
          }
        }}
        onChange={async (event, newValue, reason, details) => {
          setSpeakerError(false, '');
          if (newValue.length >= 4) {
            alert('You can only add up to 3 speakers');
            return;
          }
          const selection = ++imageSelection.current;
          setDefaultImageWarning(undefined);
          if (reason === 'removeOption' && details?.option.listId) {
            setSermonList((previousList) => {
              return previousList.filter((prevList) => prevList.id !== details.option.listId);
            });
          } else if (reason === 'clear') {
            setSermonList((previousList) => {
              return previousList.filter((prevList) => prevList.type !== ListType.SPEAKER_LIST);
            });
          }

          if (newValue !== null && newValue.length <= 3) {
            if (newValue.length === 1) {
              const speaker = newValue[0];
              const imagesAtSelection = sermonImages;
              void loadSpeakerImageDefaults(speaker.images ?? [], imagesAtSelection, async (id) => {
                const snapshot = await getDocFromServer(doc(firestore, 'images', id));
                return snapshot.exists() ? { id: snapshot.id, data: snapshot.data() } : undefined;
              })
                .then(({ images, unavailable }) => {
                  if (!mounted.current || selection !== imageSelection.current) return;
                  if (unavailable)
                    setDefaultImageWarning('Some speaker default images are unavailable. Choose an image if needed.');
                  setSermon((current) =>
                    applySpeakerImageDefaults(current, images, {
                      speakerId: speaker.id,
                      imagesAtSelection,
                      selection,
                      currentSelection: imageSelection.current,
                      mounted: mounted.current,
                    })
                  );
                })
                .catch(() => {
                  if (mounted.current && selection === imageSelection.current)
                    setDefaultImageWarning('Speaker default images could not be checked. Choose an image if needed.');
                });
            }

            updateSermon(
              'speakers',
              newValue.map((speaker) => {
                const { _highlightResult, ...speakerWithoutHighlight } = speaker;
                return speakerWithoutHighlight;
              })
            );
            if (details?.option.listId) {
              const q = query(collection(firestore, 'lists'), where('id', '==', details.option.listId)).withConverter(
                listConverter
              );
              const querySnapshot = await getDocs(q);

              if (querySnapshot.docs.length > 0) {
                const list = querySnapshot.docs[0].data();
                if (!isDiscoverableRootList(list)) {
                  console.warn(`Attempted to add overflow list ${details.option.listId} - skipping`);
                  return;
                }
                setSermonList((oldSermonList) => {
                  if (
                    oldSermonList.find((existingSermon) => {
                      return existingSermon.id === list.id;
                    })
                  ) {
                    return oldSermonList;
                  }
                  return [...oldSermonList, list];
                });
              } else {
                console.warn(`No list found with id: ${details.option.listId}`);
              }
            }
          }
        }}
        onInputChange={(_, value) => {
          setSearchInput(value);
          if (!client) return; // MUI filters the loaded browse pages locally.
          setHasCompletedSearch(false);
          if (timerRef.current) {
            clearTimeout(timerRef.current);
          }
          timerRef.current = setTimeout(async () => {
            setSearchLoading(true);
            const requestId = ++latestSearchRequestRef.current;
            const speakerResults = await fetchSpeakerResults(value, 25, 0, client);
            if (requestId !== latestSearchRequestRef.current) {
              return;
            }
            setSpeakersArray(speakerResults);
            setSearchLoading(false);
            setHasCompletedSearch(true);
          }, 300);
        }}
        id="speaker-input"
        options={getSpeakersUnion(sermonSpeakers, speakersArray)}
        loading={searchLoading}
        loadingText="Searching speakers..."
        noOptionsText={
          showSpeakerRequestAction && hasCompletedSearch && searchInput.trim().length > 0 ? (
            <Box
              sx={{
                py: 1,
                display: 'inline-flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 1,
              }}
            >
              <Typography variant="body2">Need to add a new speaker please make a request here</Typography>
              <Button
                size="small"
                variant="outlined"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onOpenSpeakerRequest}
                sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
              >
                Here
              </Button>
            </Box>
          ) : (
            'No speakers found'
          )
        }
        isOptionEqualToValue={(option, value) => value === undefined || option === undefined || option.id === value.id}
        renderTags={(speakers, getTagProps) => {
          return speakers.map((speaker, index) => {
            const { key: _tagKey, ...tagProps } = getTagProps({ index });
            return (
              <Chip
                {...tagProps}
                onDelete={() => {
                  imageSelection.current++;
                  setDefaultImageWarning(undefined);
                  setSpeakerError(false, '');
                  setSermon((previousSermon) => {
                    const newImages = previousSermon.images.filter((img) => {
                      return !speaker.images?.find((image) => image.id === img.id);
                    });
                    updateSermon('images', newImages);
                    const previousSpeakers = previousSermon.speakers;
                    const newSpeakers = previousSpeakers.filter((s) => s.id !== speaker.id);
                    return {
                      ...previousSermon,
                      speakers: newSpeakers,
                    };
                  });
                  setSermonList((oldSermonList) => oldSermonList.filter((list) => list.id !== speaker.listId));
                }}
                key={speaker.id}
                label={speaker.name}
                sx={{ mr: 0.5, mb: 0.5 }}
                avatar={
                  <AvatarWithDefaultImage
                    defaultImageURL="/user.png"
                    altName={speaker.name}
                    width={24}
                    height={24}
                    image={speaker.images?.find((image) => image.type === 'square')}
                    borderRadius={12}
                  />
                }
              />
            );
          });
        }}
        renderOption={(props, option: AlgoliaSpeaker) => {
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
              {option._highlightResult && sermonSpeakers?.find((s) => s.id === option?.id) === undefined ? (
                <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(option._highlightResult.name.value) }}></div>
              ) : (
                <div>{option.name}</div>
              )}
            </ListItem>
          );
        }}
        getOptionLabel={(option: AlgoliaSpeaker) => option.name}
        multiple
        renderInput={(params) => {
          return (
            <TextField
              {...params}
              required
              label="Speaker(s)"
              error={showError(speakerError)}
              helperText={getErrorMessage(speakerError)}
            />
          );
        }}
      />
      {defaultImageWarning && (
        <Typography role="status" color="warning.main">
          {defaultImageWarning}
        </Typography>
      )}
      {!client && (
        <Typography variant="caption">
          Search is unavailable. Filter the speakers loaded below, or load more.
        </Typography>
      )}
      {browseError && <Typography color="error">{browseError}</Typography>}
      {!client && (browsePage?.hasMore || browseError) && (
        <Button disabled={searchLoading} onClick={() => void loadMoreSpeakers()}>
          {browseError ? 'Retry loading speakers' : 'Load more speakers'}
        </Button>
      )}
    </>
  );
}

export default memo(SpeakerSelector);
