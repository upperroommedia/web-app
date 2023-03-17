/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import dynamic from 'next/dynamic';
import uploadFile from './api/uploadFile';
import editSermon from './api/editSermon';
import styles from '../styles/Uploader.module.css';
import { ChangeEvent, Dispatch, SetStateAction, useEffect, useState } from 'react';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import Cancel from '@mui/icons-material/Cancel';

import firestore, { doc, getDoc } from '../firebase/firestore';
import { emptySermon } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';

import Button from '@mui/material/Button';
import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import ProtectedRoute from '../components/ProtectedRoute';
import useAuth from '../context/user/UserContext';
import DropZone, { UploadableFile } from '../components/DropZone';
import { ISpeaker } from '../types/Speaker';
import Chip from '@mui/material/Chip';
import { sanitize } from 'dompurify';
// import ImageUploader from '../components/ImageUploader';

import algoliasearch from 'algoliasearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import ImageViewer from '../components/ImageViewer';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import AvatarWithDefaultImage from '../components/AvatarWithDefaultImage';
import ListItem from '@mui/material/ListItem';
import { UploaderFieldError } from '../context/types';
import SeriesSelector from '../components/SeriesSelector';
import { Series } from '../types/Series';

const DynamicAudioTrimmer = dynamic(() => import('../components/AudioTrimmer'), { ssr: false });

interface UploaderProps {
  existingSermon?: Sermon;
  existingSeries?: Series[];
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

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

const getSpeakersUnion = (array1: AlgoliaSpeaker[], array2: AlgoliaSpeaker[]) => {
  const difference = array1.filter((s1) => !array2.find((s2) => s1.id === s2.id));
  return [...difference, ...array2].sort((a, b) => (a.name > b.name ? 1 : -1));
};

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const speakersIndex = client?.initIndex('speakers');
const topicsIndex = client?.initIndex('topics');

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

const Uploader = (props: UploaderProps & InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const { user } = useAuth();
  const [sermon, setSermon] = useState<Sermon>(props.existingSermon || emptySermon);
  const [sermonSeries, setSermonSeries] = useState<Series[]>(props.existingSeries || []);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState({ error: false, message: '' });

  const [subtitlesArray, setSubtitlesArray] = useState<string[]>([]);

  const [speakersArray, setSpeakersArray] = useState<AlgoliaSpeaker[]>([]);
  const [topicsArray, setTopicsArray] = useState<string[]>([]);
  const [trimStart, setTrimStart] = useState<number>(0);

  const [timer, setTimer] = useState<NodeJS.Timeout>();

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date>(props.existingSermon ? new Date(props.existingSermon.dateMillis) : new Date());

  const [speakerError, setSpeakerError] = useState<UploaderFieldError>({ error: false, message: '' });
  const [topicError, setTopicError] = useState<UploaderFieldError>({ error: false, message: '' });

  useEffect(() => {
    const fetchData = async () => {
      const subtitlesRef = doc(firestore, 'subtitles', 'subtitlesDoc');
      const subtitlesSnap = await getDoc(subtitlesRef);
      const subtitlesData = subtitlesSnap.data();
      setSubtitlesArray(subtitlesData ? subtitlesSnap.data()?.subtitlesArray : []);

      // fetch speakers
      setSpeakersArray(await fetchSpeakerResults('', 20, 0));
      // fetch topics
      setTopicsArray(await fetchTopicsResults(''));
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (props.existingSeries) {
      setSermonSeries(props.existingSeries);
    }
  }, [props.existingSeries]);
  const seriesEqual = (series1: Series[], series2: Series[]): boolean => {
    return JSON.stringify(series1) === JSON.stringify(series2);
  };
  const sermonsEqual = (sermon1: Sermon, sermon2: Sermon): boolean => {
    const sermon1Date = new Date(sermon1.dateMillis);
    return (
      sermon1.title === sermon2.title &&
      sermon1.subtitle === sermon2.subtitle &&
      sermon1.description === sermon2.description &&
      sermon1Date.getDate() === date?.getDate() &&
      sermon1Date.getMonth() === date?.getMonth() &&
      sermon1Date.getFullYear() === date?.getFullYear() &&
      JSON.stringify(sermon1.images) === JSON.stringify(sermon.images) &&
      JSON.stringify(sermon1.speakers) === JSON.stringify(sermon.speakers) &&
      JSON.stringify(sermon1.topics) === JSON.stringify(sermon.topics)
    );
  };

  const clearForm = () => {
    setSpeakerError({ error: false, message: '' });
    setTopicError({ error: false, message: '' });
    setSermon(emptySermon);
    setSermonSeries([]);
    setDate(new Date());
    setFile(undefined);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSermon((prevSermon) => {
      return {
        ...prevSermon,
        [event.target.name]: event.target.value,
      };
    });
  };

  const updateSermon = <T extends keyof Sermon>(key: T, value: Sermon[T]) => {
    setSermon((oldSermon) => ({ ...oldSermon, [key]: value }));
  };

  const handleDateChange = (newValue: Date) => {
    setDate(newValue);
    updateSermon('dateMillis', newValue.getTime());
  };

  const setTrimDuration = (durationSeconds: number) => {
    updateSermon('durationSeconds', durationSeconds);
  };

  const fetchTopicsResults = async (query: string) => {
    const res: string[] = [];
    if (topicsIndex) {
      const response = await topicsIndex.search(query, {
        hitsPerPage: 5,
      });
      response?.hits.forEach((element: any) => {
        res.push(element.name);
      });
    }
    return res;
  };

  const handleNewImage = (image: ImageType | ImageSizeType) => {
    setSermon((oldSermon) => {
      // check if image is ImageType or ImageSizeType
      if (isImageType(image)) {
        const castedImage = image as ImageType;
        let newImages: ImageType[] = [];
        if (oldSermon.images.find((img) => img.type === castedImage.type)) {
          newImages = oldSermon.images.map((img) => (img.type === castedImage.type ? castedImage : img));
        } else {
          newImages = [...oldSermon.images, castedImage];
        }
        return {
          ...oldSermon,
          images: newImages,
        };
      } else {
        const imageSizeType = image as ImageSizeType;
        return {
          ...oldSermon,
          images: oldSermon.images.filter((img) => img.type !== imageSizeType),
        };
      }
    });
  };

  return (
    <form className={styles.container}>
      <h1 style={{ justifySelf: 'center', gridColumn: '1/3' }}>{props.existingSermon ? 'Edit Sermon' : 'Uploader'}</h1>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1ch',
          margin: 'auto',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TextField
          sx={{
            display: 'block',
            width: 1,
          }}
          fullWidth
          id="title-input"
          label="Title"
          name="title"
          variant="outlined"
          value={sermon.title}
          onChange={handleChange}
          required
        />
        <Box sx={{ display: 'flex', gap: '1ch', width: 1 }}>
          <Autocomplete
            fullWidth
            id="subtitle-input"
            value={sermon.subtitle || null}
            onChange={(_, newValue) => {
              newValue === null ? updateSermon('subtitle', '') : updateSermon('subtitle', newValue);
            }}
            renderInput={(params) => <TextField required {...params} label="Subtitle" />}
            options={subtitlesArray}
          />
          <LocalizationProvider dateAdapter={AdapterDateFns} sx={{ width: 1 }} fullWidth>
            <DesktopDatePicker
              label="Date"
              inputFormat="MM/dd/yyyy"
              value={date}
              onChange={(newValue) => {
                if (newValue !== null) {
                  handleDateChange(new Date(newValue));
                }
              }}
              renderInput={(params) => <TextField {...params} />}
            />
          </LocalizationProvider>
        </Box>
        <TextField
          sx={{
            display: 'block',
          }}
          fullWidth
          rows={4}
          id="description-text"
          label="Description"
          name="description"
          placeholder="Description"
          multiline
          value={sermon.description}
          onChange={handleChange}
        />
        <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
          <SeriesSelector sermonSeries={sermonSeries} setSermonSeries={setSermonSeries} />
        </div>
        <Autocomplete
          fullWidth
          value={sermon.speakers}
          onBlur={() => {
            setSpeakerError({ error: false, message: '' });
          }}
          onChange={async (_, newValue) => {
            if (newValue.length === 1) {
              const currentTypes = sermon.images.map((img) => img.type);
              const newImages = [
                ...sermon.images,
                ...newValue[0].images.filter((img) => !currentTypes.includes(img.type)),
              ];
              updateSermon('images', newImages);
            }
            if (newValue !== null && newValue.length <= 3) {
              updateSermon(
                'speakers',
                newValue.map((speaker) => {
                  const { _highlightResult, ...speakerWithoutHighlight } = speaker;
                  return speakerWithoutHighlight;
                })
              );
            }

            if (newValue.length >= 4) {
              setSpeakerError({
                error: true,
                message: 'Can only add up to 3 speakers',
              });
            } else if (speakerError.error) {
              setSpeakerError({ error: false, message: '' });
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
          options={getSpeakersUnion(sermon.speakers, speakersArray)}
          isOptionEqualToValue={(option, value) =>
            value === undefined || option === undefined || option.id === value.id
          }
          renderTags={(speakers, _) => {
            return speakers.map((speaker) => (
              <Chip
                style={{ margin: '3px' }}
                onDelete={() => {
                  setSpeakerError({ error: false, message: '' });
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
                }}
                key={speaker.id}
                label={speaker.name}
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
            ));
          }}
          renderOption={(props, option: AlgoliaSpeaker) => (
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
              {option._highlightResult && sermon.speakers?.find((s) => s.id === option?.id) === undefined ? (
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
                error={speakerError.error}
                helperText={speakerError.message}
              />
            );
          }}
        />
        <Autocomplete
          fullWidth
          value={sermon.topics}
          onBlur={() => {
            setTopicError({ error: false, message: '' });
          }}
          onChange={(_, newValue) => {
            if (newValue !== null && newValue.length <= 10) {
              updateSermon('topics', newValue);
            } else if (newValue.length >= 11) {
              setTopicError({
                error: true,
                message: 'Can only add up to 10 topics',
              });
            }
          }}
          onInputChange={async (_, value) => {
            const topics = await fetchTopicsResults(value);
            setTopicsArray(topics);
          }}
          id="topic-input"
          options={topicsArray}
          multiple
          renderInput={(params) => (
            <TextField {...params} label="Topic(s)" error={topicError.error} helperText={topicError.message} />
          )}
        />
      </Box>
      <div>
        <ImageViewer
          images={sermon.images}
          speaker={sermon.speakers[0]}
          newImageCallback={handleNewImage}
          vertical={true}
        />
      </div>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1ch',
          margin: 'auto',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.existingSermon && props.existingSeries ? (
          <div style={{ display: 'grid', margin: 'auto', paddingTop: '20px' }}>
            <Button
              onClick={async () => {
                console.log('HERHERH', sermonSeries);
                await editSermon(sermon, sermonSeries);
                props.setEditFormOpen?.(false);
              }}
              disabled={
                (sermonsEqual(props.existingSermon, sermon) && seriesEqual(props.existingSeries, sermonSeries)) ||
                sermon.title === '' ||
                date === null ||
                sermon.speakers.length === 0 ||
                sermon.subtitle === ''
              }
              variant="contained"
            >
              update sermon
            </Button>
          </div>
        ) : (
          <>
            {file ? (
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'right' }}>
                  <Cancel sx={{ color: 'red' }} onClick={() => setFile(undefined)} />
                </div>
                <DynamicAudioTrimmer
                  url={file.preview}
                  trimStart={trimStart}
                  setTrimStart={setTrimStart}
                  setTrimDuration={setTrimDuration}
                />
              </div>
            ) : (
              <DropZone setFile={setFile} />
            )}
            <div style={{ display: 'flex' }}>
              <input
                className={styles.button}
                type="button"
                value="Upload"
                disabled={
                  file === undefined ||
                  sermon.title === '' ||
                  date === null ||
                  sermon.speakers.length === 0 ||
                  sermon.subtitle === ''
                }
                onClick={async () => {
                  if (file !== undefined && date != null && user?.role === 'admin') {
                    try {
                      await uploadFile({
                        file,
                        setFile,
                        setUploadProgress,
                        trimStart,
                        sermon,
                        sermonSeries,
                      });
                      clearForm();
                    } catch (error) {
                      setUploadProgress({ error: true, message: `Error uploading file: ${error}` });
                    }
                  } else if (user?.role !== 'admin') {
                    setUploadProgress({ error: true, message: 'You do not have permission to upload' });
                  }
                }}
              />
              <button type="button" className={styles.button} onClick={() => clearForm()}>
                Clear Form
              </button>
            </div>
            <p style={{ textAlign: 'center', color: uploadProgress.error ? 'red' : 'black' }}>
              {uploadProgress.message}
            </p>
          </>
        )}
      </Box>
    </form>
  );
};

export default Uploader;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || !['admin', 'uploader'].includes(userCredentials.props.customClaims?.role)) {
    return {
      redirect: {
        permanent: false,
        destination: '/',
      },
      props: {},
    };
  }
  return { props: {} };
};
