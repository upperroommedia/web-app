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

import { isBrowser } from 'react-device-detect';

import firestore, { collection, getDocs, query, where } from '../firebase/firestore';
import { createEmptySermon } from '../types/Sermon';
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
import ListSelector from '../components/ListSelector';
import FormControl from '@mui/material/FormControl';
// import Switch from '@mui/material/Switch';
// import FormControlLabel from '@mui/material/FormControlLabel';
import YoutubeUrlToMp3 from '../components/YoutubeUrlToMp3';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Head from 'next/head';
import { List, listConverter, ListType } from '../types/List';
import SubtitleSelector from '../components/SubtitleSelector';

const DynamicAudioTrimmer = dynamic(() => import('../components/AudioTrimmer'), { ssr: false });

interface UploaderProps {
  existingSermon?: Sermon;
  existingList?: List[];
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
const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });

const Uploader = (props: UploaderProps & InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const { user } = useAuth();
  const [sermon, setSermon] = useState<Sermon>(props.existingSermon || createEmptySermon());
  const [sermonList, setSermonList] = useState<List[]>(props.existingList || []);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState({ error: false, percent: 0, message: '' });
  const [isUploading, setIsUploading] = useState(false);
  const [useYoutubeUrl, _setUseYoutubeUrl] = useState(false);

  const [speakersArray, setSpeakersArray] = useState<AlgoliaSpeaker[]>([]);
  const [speakerHasNoListPopup, setSpeakerHasNoListPopup] = useState(false);

  const [subtitles, setSubtitles] = useState<List[]>([]);

  const [trimStart, setTrimStart] = useState<number>(0);

  const [timer, setTimer] = useState<NodeJS.Timeout>();

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date>(props.existingSermon ? new Date(props.existingSermon.dateMillis) : new Date());

  const [speakerError, setSpeakerError] = useState<UploaderFieldError>({ error: false, message: '' });

  useEffect(() => {
    const fetchData = async () => {
      // fetch speakers
      setSpeakersArray(await fetchSpeakerResults('', 20, 0));

      // fetch subtitles
      const listQuery = query(
        collection(firestore, 'lists'),
        where('type', '==', ListType.CATEGORY_LIST)
      ).withConverter(listConverter);
      const listQuerySnapshot = await getDocs(listQuery);
      setSubtitles(
        listQuerySnapshot.docs.map((doc) => {
          const list = doc.data();
          return list;
        })
      );

      // fetch latest list
      if (sermonList.find((list) => list.type === ListType.LATEST) !== undefined) {
        const latestQuery = query(collection(firestore, 'lists'), where('type', '==', ListType.LATEST)).withConverter(
          listConverter
        );
        const latestSnap = await getDocs(latestQuery);
        setSermonList((oldSermonList) => [...oldSermonList, latestSnap.docs[0].data()]);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (props.existingList) {
      setSermonList(props.existingList);
    }
  }, [props.existingList]);

  const listEqual = (list1: List[], list2: List[]): boolean => {
    return JSON.stringify(list1) === JSON.stringify(list2);
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
  const clearAudioTrimmer = () => {
    setFile(undefined);
    setTrimStart(0);
  };
  const clearForm = () => {
    setSpeakerError({ error: false, message: '' });
    setSermon(createEmptySermon());
    setSermonList([]);
    setDate(new Date());
    clearAudioTrimmer();
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
    <>
      <Head>
        <title>Uploader</title>
        <meta property="og:title" content="Uploader" key="title" />
        <meta name="description" content="Upload christian sermons to Upper Room Meida" key="description" />
      </Head>
      <FormControl
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'auto', md: '4fr 1fr' },
          maxWidth: '80%',
          gap: '1ch 100px',
          margin: 'auto',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <h1 style={{ justifySelf: 'center', gridColumn: '1/-1' }}>
          {props.existingSermon ? 'Edit Sermon' : 'Uploader'}
        </h1>
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
            <SubtitleSelector
              sermonList={sermonList}
              setSermonList={setSermonList}
              sermon={sermon}
              setSermon={setSermon}
              subtitles={subtitles}
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
            <ListSelector
              sermonList={sermonList}
              setSermonList={setSermonList}
              listType={ListType.SERIES}
              subtitle={
                sermon.subtitle !== '' ? subtitles.find((subtitle) => subtitle.name === sermon.subtitle) : undefined
              }
            />
          </div>
          <Autocomplete
            fullWidth
            value={sermon.speakers}
            onBlur={() => {
              setSpeakerError({ error: false, message: '' });
            }}
            onChange={async (_, newValue, _reason, details) => {
              if (!details?.option.listId) {
                setSpeakerHasNoListPopup(true);
              }
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
                if (details?.option.listId) {
                  const q = query(
                    collection(firestore, 'lists'),
                    where('id', '==', details.option.listId)
                  ).withConverter(listConverter);
                  const querySnapshot = await getDocs(q);
                  const list = querySnapshot.docs[0].data();
                  setSermonList((oldSermonList) => [...oldSermonList, list]);
                }
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
                    setSermonList((oldSermonList) => oldSermonList.filter((list) => list.id !== speaker.listId));
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
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector sermonList={sermonList} setSermonList={setSermonList} listType={ListType.TOPIC_LIST} />
          </div>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector sermonList={sermonList} setSermonList={setSermonList} />
          </div>
        </Box>
        <Box sx={{ margin: 'auto' }} width={1} maxWidth={300} minWidth={200}>
          <ImageViewer
            images={sermon.images}
            speaker={sermon.speakers[0]}
            newImageCallback={handleNewImage}
            vertical={true}
          />
        </Box>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1ch',
            margin: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
            width: 1,
          }}
        >
          {props.existingSermon && props.existingList ? (
            <div style={{ display: 'grid', margin: 'auto', paddingTop: '20px' }}>
              <Button
                onClick={async () => {
                  await editSermon(sermon, sermonList);
                  props.setEditFormOpen?.(false);
                }}
                disabled={
                  (sermonsEqual(props.existingSermon, sermon) && listEqual(props.existingList, sermonList)) ||
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
                    <Cancel sx={{ color: 'red' }} onClick={clearAudioTrimmer} />
                  </div>
                  {isBrowser ? (
                    <DynamicAudioTrimmer
                      url={file.preview}
                      trimStart={trimStart}
                      setTrimStart={setTrimStart}
                      setTrimDuration={setTrimDuration}
                    />
                  ) : (
                    <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center">
                      <audio style={{ width: '100%' }} controls src={file.preview} />
                      <Typography variant="caption">
                        Trimming is not currently supported on mobile: please trim your audio on a seperate application
                        first
                      </Typography>
                    </Box>
                  )}
                </div>
              ) : (
                <Box
                  display="flex"
                  flexDirection="column"
                  width={1}
                  justifyContent="center"
                  alignItems="center"
                  gap={1}
                >
                  {/* <FormControlLabel
                    control={
                      <Switch
                        checked={useYoutubeUrl}
                        onChange={() => setUseYoutubeUrl((prevValue) => !prevValue)}
                        inputProps={{ 'aria-label': 'controlled' }}
                      />
                    }
                    label="Upload from Youtube Url"
                  /> */}
                  {useYoutubeUrl ? <YoutubeUrlToMp3 setFile={setFile} /> : <DropZone setFile={setFile} />}
                </Box>
              )}
              <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
                <Box display="flex">
                  <input
                    className={styles.button}
                    type="button"
                    value="Upload"
                    disabled={
                      file === undefined ||
                      sermon.title === '' ||
                      date === null ||
                      sermon.speakers.length === 0 ||
                      sermon.subtitle === '' ||
                      isUploading
                    }
                    onClick={async () => {
                      if (file !== undefined && date != null && user?.role === 'admin') {
                        try {
                          setIsUploading(true);
                          await uploadFile({
                            file,
                            setUploadProgress,
                            trimStart,
                            sermon,
                            sermonList,
                          });
                          setIsUploading(false);
                          clearForm();
                        } catch (error) {
                          setUploadProgress({ error: true, message: `Error uploading file: ${error}`, percent: 0 });
                        }
                      } else if (user?.role !== 'admin') {
                        setUploadProgress({ error: true, message: 'You do not have permission to upload', percent: 0 });
                      }
                    }}
                  />
                  <button type="button" className={styles.button} onClick={() => clearForm()}>
                    Clear Form
                  </button>
                </Box>
                <Box display="flex" width={1} gap={1} justifyContent="center" alignItems="center">
                  {isUploading && (
                    <Box width={1}>
                      <LinearProgress variant="determinate" value={uploadProgress.percent} />
                    </Box>
                  )}
                  {uploadProgress.message && (
                    <Typography sx={{ textAlign: 'center', color: uploadProgress.error ? 'red' : 'black' }}>
                      {!uploadProgress.error && uploadProgress.percent < 100
                        ? `${uploadProgress.percent}%`
                        : uploadProgress.message}
                    </Typography>
                  )}
                </Box>
              </Box>
            </>
          )}
        </Box>
        <DynamicPopUp title={'Warning'} open={speakerHasNoListPopup} setOpen={setSpeakerHasNoListPopup}>
          Speaker has no associated list that this sermon will be added to
        </DynamicPopUp>
      </FormControl>
    </>
  );
};

export default Uploader;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || !['admin', 'uploader'].includes(userCredentials.props.customClaims?.role)) {
    return userCredentials;
  }
  return { props: {} };
};
