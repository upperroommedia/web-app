import React, { Dispatch, SetStateAction, memo, useEffect, useState } from 'react';
import AvatarWithDefaultImage from '../AvatarWithDefaultImage';
import ListItem from '@mui/material/ListItem';
import { ISpeaker } from '../../types/Speaker';
import Autocomplete from '@mui/material/Autocomplete';
import { UploaderFieldError } from '../../context/types';
import firestore, { collection, getDocs, query, where } from '../../firebase/firestore';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import { sanitize } from 'dompurify';
import { List, ListType, listConverter } from '../../types/List';
import dynamic from 'next/dynamic';
import algoliasearch from 'algoliasearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import { Sermon } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { getErrorMessage, showError } from './utils';

const DynamicPopUp = dynamic(() => import('../PopUp'), { ssr: false });

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
}

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const speakersIndex = client?.initIndex('speakers');

export const fetchSpeakerResults = async (query: string, hitsPerPage: number, page: number) => {
  const speakers: AlgoliaSpeaker[] = [];
  if (speakersIndex) {
    const response = await speakersIndex.search<AlgoliaSpeaker>(query, {
      hitsPerPage,
      page,
    });
    response.hits.forEach((hit) => {
      speakers.push(hit);
    });
  }
  return speakers;
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
}: SpeakerSelectorProps) {
  const [timer, setTimer] = useState<NodeJS.Timeout>();
  const [speakersArray, setSpeakersArray] = useState<AlgoliaSpeaker[]>([]);
  const [speakerHasNoListPopup, setSpeakerHasNoListPopup] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      // fetch speakers
      setSpeakersArray(await fetchSpeakerResults('', 20, 0));
    };
    fetchData();
  }, []);

  return (
    <>
      <Autocomplete
        fullWidth
        value={sermonSpeakers}
        onBlur={() => {
          if (sermonSpeakers.length === 0) {
            setSpeakerError(true, 'You must select at least one speaker');
          }
        }}
        onChange={async (event, newValue, reason, details) => {
          setSpeakerError(false, '');
          if (reason === 'removeOption' && details?.option.listId) {
            setSermonList((previousList) => {
              return previousList.filter((prevList) => prevList.id !== details.option.listId);
            });
          } else if (reason === 'clear') {
            setSermonList((previousList) => {
              return previousList.filter((prevList) => prevList.type !== ListType.SPEAKER_LIST);
            });
          } else if (reason === 'selectOption' && !details?.option.listId) {
            setSpeakerHasNoListPopup(true);
          }

          if (newValue !== null && newValue.length <= 3) {
            if (newValue.length === 1) {
              const currentTypes = sermonImages.map((img) => img.type);
              const newImages = [
                ...sermonImages,
                ...newValue[0].images.filter((img) => !currentTypes.includes(img.type)),
              ];
              updateSermon('images', newImages);
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
              const list = querySnapshot.docs[0].data();
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
            }
          } else if (newValue.length >= 4) {
            setSpeakerError(true, 'Can only add up to 3 speakers');
          }
        }}
        onInputChange={async (_, value) => {
          clearTimeout(timer);
          const newTimer = setTimeout(async () => {
            setSpeakersArray(await fetchSpeakerResults(value, 25, 0));
          }, 300);
          setTimer(newTimer);
        }}
        id="speaker-input"
        options={getSpeakersUnion(sermonSpeakers, speakersArray)}
        isOptionEqualToValue={(option, value) => value === undefined || option === undefined || option.id === value.id}
        renderTags={(speakers, _) => {
          return speakers.map((speaker) => (
            <Chip
              style={{ margin: '3px' }}
              onDelete={() => {
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
              avatar={
                <AvatarWithDefaultImage
                  defaultImageURL="/props.user.png"
                  altName={speaker.name}
                  width={24}
                  height={24}
                  image={speaker.images?.find((image) => image.type === 'square')}
                  borderRadius={12}
                />
              }
            />
          ));
        }}
        renderOption={(props, option: AlgoliaSpeaker) => (
          <ListItem key={option.id} {...props}>
            <AvatarWithDefaultImage
              defaultImageURL="/props.user.png"
              altName={option.name}
              width={30}
              height={30}
              image={option.images?.find((image) => image.type === 'square')}
              borderRadius={5}
              sx={{ marginRight: '15px' }}
            />
            {option._highlightResult && sermonSpeakers?.find((s) => s.id === option?.id) === undefined ? (
              <div dangerouslySetInnerHTML={{ __html: sanitize(option._highlightResult.name.value) }}></div>
            ) : (
              <div>{option.name}</div>
            )}
          </ListItem>
        )}
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
      <DynamicPopUp title={'Warning'} open={speakerHasNoListPopup} setOpen={setSpeakerHasNoListPopup}>
        Speaker has no associated list that this sermon will be added to
      </DynamicPopUp>
    </>
  );
}

export default memo(SpeakerSelector);
