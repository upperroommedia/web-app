/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import dynamic from 'next/dynamic';
import uploadFile from './api/uploadFile';
import editSermon from './api/editSermon';
import addNewSeries from './api/addNewSeries';
import styles from '../styles/Uploader.module.css';
import { ChangeEvent, Dispatch, SetStateAction, useEffect, useState } from 'react';

import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';
import Cancel from '@mui/icons-material/Cancel';

import firestore, { collection, doc, getDoc, getDocs, query } from '../firebase/firestore';
import { emptySermon, getDateString, createSermon } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';

import Button from '@mui/material/Button';
import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import Image from 'next/image';
import ProtectedRoute from '../components/ProtectedRoute';
import useAuth from '../context/user/UserContext';
import DropZone, { UploadableFile } from '../components/DropZone';
import { ISpeaker } from '../types/Speaker';
import Chip from '@mui/material/Chip';
import { sanitize } from 'dompurify';
// import ImageUploader from '../components/ImageUploader';

import algoliasearch from 'algoliasearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';

const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });
const DynamicAudioTrimmer = dynamic(() => import('../components/AudioTrimmer'), { ssr: false });

interface UploaderProps {
  existingSermon?: Sermon;
  setUpdatedSermon?: Dispatch<SetStateAction<Sermon>>;
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

const getSpeakersUnion = (array1: ISpeaker[], array2: ISpeaker[]) => {
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
  if (speakersIndex) {
    const response = await speakersIndex.search<ISpeaker>(query, {
      hitsPerPage,
      page,
    });
    return response;
  }
};

const Uploader = (props: UploaderProps & InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const { user } = useAuth();
  const [sermon, setSermon] = useState<Sermon>(props.existingSermon ? props.existingSermon : emptySermon);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState({ error: false, message: '' });

  const [subtitlesArray, setSubtitlesArray] = useState<string[]>([]);
  const [seriesArray, setSeriesArray] = useState<string[]>([]);
  const [speakersArray, setSpeakersArray] = useState<ISpeaker[]>([]);
  const [topicsArray, setTopicsArray] = useState<string[]>([]);
  const [trimStart, setTrimStart] = useState<number>(0);

  const [timer, setTimer] = useState<NodeJS.Timeout>();

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date>(new Date(props.existingSermon ? props.existingSermon.dateMillis : new Date()));

  const [newSeries, setNewSeries] = useState<string>('');
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);

  const [speakerError, setSpeakerError] = useState<{ error: boolean; message: string }>({ error: false, message: '' });
  const [topicError, setTopicError] = useState<{ error: boolean; message: string }>({ error: false, message: '' });

  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });

  const [userHasTypedInSeries, setUserHasTypedInSeries] = useState<boolean>(false);

  // const [editImagePopup, setEditImagePopup] = useState<boolean>(false);
  // const [imageToEdit, setImageToEdit] = useState({ url: '', imageIndex: 0 });

  useEffect(() => {
    if (!userHasTypedInSeries) {
      setNewSeriesError({ error: false, message: '' });
      return;
    }

    if (newSeries === '') {
      setNewSeriesError({ error: true, message: 'Series cannot be empty' });
    } else if (seriesArray.includes(newSeries)) {
      setNewSeriesError({ error: true, message: 'Series already exists' });
    } else {
      setNewSeriesError({ error: false, message: '' });
    }
  }, [newSeries, userHasTypedInSeries, seriesArray]);

  useEffect(() => {
    const fetchData = async () => {
      const subtitlesRef = doc(firestore, 'subtitles', 'subtitlesDoc');
      const subtitlesSnap = await getDoc(subtitlesRef);
      const subtitlesData = subtitlesSnap.data();
      setSubtitlesArray(subtitlesData ? subtitlesSnap.data()?.subtitlesArray : []);

      const seriesQuery = query(collection(firestore, 'series'));
      const seriesQuerySnapshot = await getDocs(seriesQuery);
      setSeriesArray(seriesQuerySnapshot.docs.map((doc) => doc.data().name));
    };
    fetchData();
  }, []);

  const sermonsEqual = (sermon1: Sermon, sermon2: Sermon): boolean => {
    const sermon1Date = new Date(sermon1.dateMillis);

    return (
      sermon1.title === sermon2.title &&
      sermon1.subtitle === sermon2.subtitle &&
      sermon1.description === sermon2.description &&
      sermon1Date.getDate() === date?.getDate() &&
      sermon1Date.getMonth() === date?.getMonth() &&
      sermon1Date.getFullYear() === date?.getFullYear() &&
      sermon1.series === sermon.series &&
      JSON.stringify(sermon1.speakers) === JSON.stringify(sermon.speakers) &&
      JSON.stringify(sermon1.topics) === JSON.stringify(sermon.topics)
    );
  };

  const clearForm = () => {
    setSpeakerError({ error: false, message: '' });
    setTopicError({ error: false, message: '' });
    setSermon(emptySermon);
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

  const updateSermon = (key: keyof Sermon, value: any) => {
    setSermon((oldSermon) => ({ ...oldSermon, [key]: value }));
  };

  const handleDateChange = (newValue: Date) => {
    setDate(newValue);
  };

  const setTrimDuration = (durationSeconds: number) => {
    updateSermon('durationSeconds', durationSeconds);
  };

  const fetchTopicsResults = async (query: string) => {
    if (topicsIndex) {
      const response = await topicsIndex.search(query, {
        hitsPerPage: 5,
      });
      return response;
    }
  };

  return (
    <form className={styles.container}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1ch',
          margin: 'auto',
          maxWidth: '900px',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <h1>{props.existingSermon ? 'Edit Sermon' : 'Uploader'}</h1>
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
        <Box sx={{ display: 'flex', color: 'red', gap: '1ch', width: 1 }}>
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
          <Autocomplete
            fullWidth
            value={sermon.series || null}
            onChange={(_, newValue) => {
              newValue === null ? updateSermon('series', '') : updateSermon('series', newValue);
            }}
            id="series-input"
            options={seriesArray}
            renderInput={(params) => <TextField {...params} label="Series" />}
          />
          <p style={{ paddingLeft: '10px' }}>or</p>
          <IconButton
            onClick={() => {
              setNewSeriesPopup(true);
            }}
          >
            <AddIcon />
          </IconButton>
        </div>
        <Autocomplete
          fullWidth
          value={sermon.speakers}
          onBlur={() => {
            setSpeakerError({ error: false, message: '' });
          }}
          onChange={async (_, newValue) => {
            if (newValue.length === 1) {
              updateSermon('images', newValue[0].images);
            }
            if (newValue !== null && newValue.length <= 3) {
              updateSermon('speakers', newValue);
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
              await fetchSpeakerResults(value, 25, 1).then((data) => {
                const res: ISpeaker[] = [];
                data?.hits.forEach((element: ISpeaker) => {
                  res.push(element);
                });
                setSpeakersArray(res);
              });
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
                  <div
                    style={{
                      borderRadius: '12px',
                      overflow: 'hidden',
                      position: 'relative',
                      width: 24,
                      height: 24,
                      backgroundImage: `url(${'/user.png'})`,
                      backgroundPosition: 'center center',
                      backgroundSize: 'cover',
                    }}
                  >
                    {speaker.images?.find((image) => image.type === 'square') && (
                      <Image
                        src={sanitize(speaker.images.find((image) => image.type === 'square')!.downloadLink)}
                        layout="fill"
                      />
                    )}
                  </div>
                }
              />
            ));
          }}
          renderOption={(props, option: ISpeaker) => {
            const squareImage = option.images?.find((image) => image.type === 'square');
            return (
              <li key={option.name} {...props}>
                <div
                  style={{
                    borderRadius: '5px',
                    overflow: 'hidden',
                    position: 'relative',
                    width: 30,
                    height: 30,
                    marginRight: 15,
                    backgroundImage: `url(${'/user.png'})`,
                    backgroundPosition: 'center center',
                    backgroundSize: 'cover',
                  }}
                >
                  {squareImage && <Image src={sanitize(squareImage.downloadLink)} layout="fill" />}
                </div>
                <div>{option.name}</div>
              </li>
            );
          }}
          getOptionLabel={(option: ISpeaker) => option.name}
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
            await fetchTopicsResults(value).then((data) => {
              const res: string[] = [];
              data?.hits.forEach((element: any) => {
                res.push(element.name);
              });
              setTopicsArray(res);
            });
          }}
          id="topic-input"
          options={topicsArray}
          multiple
          renderInput={(params) => (
            <TextField {...params} label="Topic(s)" error={topicError.error} helperText={topicError.message} />
          )}
        />
        {props.existingSermon ? (
          <div style={{ display: 'grid', margin: 'auto', paddingTop: '20px' }}>
            <Button
              onClick={() =>
                editSermon({
                  key: sermon.key,
                  title: sermon.title,
                  subtitle: sermon.subtitle,
                  description: sermon.description,
                  speakers: sermon.speakers,
                  topics: sermon.topics,
                  series: sermon.series,
                  images: sermon.images,
                }).then(() => {
                  props.setUpdatedSermon?.(
                    createSermon({
                      key: sermon.key,
                      title: sermon.title,
                      subtitle: sermon.subtitle,
                      dateMillis: date.getTime(),
                      durationSeconds: sermon.durationSeconds,
                      description: sermon.description,
                      speakers: sermon.speakers,
                      topics: sermon.topics,
                      series: sermon.series,
                      dateString: getDateString(date),
                    })
                  );
                  props.setEditFormOpen?.(false);
                })
              }
              disabled={
                sermonsEqual(props.existingSermon, sermon) ||
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
                  <Cancel sx={{ color: 'red' }} onClick={() => setFile(undefined)}></Cancel>
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
          </>
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
                    date,
                    trimStart,
                    sermon,
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
        <p style={{ textAlign: 'center', color: uploadProgress.error ? 'red' : 'black' }}>{uploadProgress.message}</p>
      </Box>
      <div style={{ margin: '0px 40px' }}>
        <h1 style={{ textAlign: 'center' }}>Images</h1>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {sermon.speakers.length > 0 &&
            sermon.speakers[0].images.map((image, _index) => {
              return (
                <div key={image.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span>{image.type.charAt(0).toUpperCase() + image.type.slice(1)}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sanitize(image.downloadLink)}
                    height="100px"
                    width="100px"
                    // onClick={() => {
                    //   setImageToEdit({ url: image.downloadLink, imageIndex: index });
                    //   setEditImagePopup(true);
                    // }}
                  />
                </div>
              );
            })}
        </div>
      </div>
      <DynamicPopUp
        title={'Add new series'}
        open={newSeriesPopup}
        setOpen={() => setNewSeriesPopup(false)}
        onClose={() => {
          setUserHasTypedInSeries(false);
          setNewSeries('');
        }}
        button={
          <Button
            variant="contained"
            disabled={newSeries === '' || seriesArray.includes(newSeries)}
            onClick={async () => {
              try {
                await addNewSeries(newSeries);
                setNewSeriesPopup(false);
                seriesArray.push(newSeries);
                updateSermon('series', newSeries);
                setNewSeries('');
              } catch (error) {
                setNewSeriesError({ error: true, message: JSON.stringify(error) });
              }
            }}
          >
            Submit
          </Button>
        }
      >
        <div style={{ display: 'flex', padding: '10px' }}>
          <TextField
            value={newSeries}
            onChange={(e) => {
              setNewSeries(e.target.value);
              !userHasTypedInSeries && setUserHasTypedInSeries(true);
            }}
            error={newSeriesError.error}
            label={newSeriesError.error ? newSeriesError.message : 'Series'}
          />
        </div>
      </DynamicPopUp>
      {/* <DynamicPopUp
        title="Edit Image"
        open={editImagePopup}
        setOpen={setEditImagePopup}
        dialogProps={{ fullWidth: true }}
      >
        <ImageUploader
          imgSrc={sanitize(imageToEdit.url)}
          onFinish={(imgSrc: string) => {
            const newImages = [...sermon.images];
            newImages[imageToEdit.imageIndex].downloadLink = imgSrc;
            newImages[imageToEdit.imageIndex].subsplashId = undefined;
            updateSermon('images', newImages);
            setEditImagePopup(false);
          }}
        />
      </DynamicPopUp> */}
    </form>
  );
};

export default Uploader;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || userCredentials.props.customClaims?.role !== 'admin') {
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
