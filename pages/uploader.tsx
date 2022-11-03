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

const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });
const DynamicAudioTrimmer = dynamic(() => import('../components/AudioTrimmer'), { ssr: false });

interface UploaderProps {
  existingSermon?: Sermon;
  setUpdatedSermon?: Dispatch<SetStateAction<Sermon>>;
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

const sortOrder = { square: 0, wide: 1, banner: 2 };
const getSpeakersUnion = (array1: ISpeaker[], array2: ISpeaker[]) => {
  const difference = array1.filter((s1) => !array2.find((s2) => s1.objectID === s2.objectID));
  return [...difference, ...array2].sort((a, b) => (a.name > b.name ? 1 : -1));
};
const Uploader = (props: UploaderProps & InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const { user } = useAuth();
  const [sermon, setSermon] = useState<Sermon>(props.existingSermon ? props.existingSermon : emptySermon);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();

  const [subtitlesArray, setSubtitlesArray] = useState<string[]>([]);
  const [seriesArray, setSeriesArray] = useState<string[]>([]);
  const [speakersArray, setSpeakersArray] = useState<ISpeaker[]>([]);
  const [topicsArray, setTopicsArray] = useState<string[]>([]);
  const [trimStart, setTrimStart] = useState<number>(0);

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
      sermon1.scripture === sermon2.scripture &&
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

  const fetchSpeakerResults = async (query: string) => {
    if (process.env.NEXT_PUBLIC_ALGOLIA_API_KEY && process.env.NEXT_PUBLIC_ALGOLIA_APP_ID) {
      const url = `https://${process.env.NEXT_PUBLIC_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/speakers/query`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Algolia-API-Key': process.env.NEXT_PUBLIC_ALGOLIA_API_KEY,
          'X-Algolia-Application-Id': process.env.NEXT_PUBLIC_ALGOLIA_APP_ID,
        },
        body: JSON.stringify({ query: query }),
      });
      return response;
    }
  };

  const fetchTopicsResults = async (query: string) => {
    if (process.env.NEXT_PUBLIC_ALGOLIA_API_KEY && process.env.NEXT_PUBLIC_ALGOLIA_APP_ID) {
      const url = `https://${process.env.NEXT_PUBLIC_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/topics/query`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Algolia-API-Key': process.env.NEXT_PUBLIC_ALGOLIA_API_KEY,
          'X-Algolia-Application-Id': process.env.NEXT_PUBLIC_ALGOLIA_APP_ID,
        },
        body: JSON.stringify({ query: query }),
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
        {/* <Image src={Logo} width={30} height={30} /> */}

        <Autocomplete
          fullWidth
          value={sermon.speakers}
          onBlur={() => {
            setSpeakerError({ error: false, message: '' });
          }}
          onChange={(_, newValue) => {
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
            await fetchSpeakerResults(value)
              .then((response) => response?.json())
              .then((data) => {
                const res: ISpeaker[] = [];
                data.hits.forEach((element: ISpeaker) => {
                  res.push(element);
                });
                setSpeakersArray(res);
              });
          }}
          id="speaker-input"
          options={getSpeakersUnion(sermon.speakers, speakersArray)}
          isOptionEqualToValue={(option, value) =>
            value === undefined || option === undefined || option.objectID === value.objectID
          }
          renderTags={(speakers, _) => {
            return speakers.map((speaker) => (
              <Chip
                style={{ margin: '3px' }}
                onDelete={() => {
                  setSpeakerError({ error: false, message: '' });
                  setSermon((previousSermon) => {
                    const previousSpeakers = previousSermon.speakers;
                    const newSpeakers = previousSpeakers.filter((s) => s.objectID !== speaker.objectID);
                    return {
                      ...previousSermon,
                      speakers: newSpeakers,
                    };
                  });
                }}
                key={speaker.objectID}
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
                    {sermon.speakers.length > 0 && (
                      <Image
                        src={
                          speaker.images.sort(
                            (a: { type: keyof typeof sortOrder }, b: { type: keyof typeof sortOrder }) => {
                              return sortOrder[a.type] - sortOrder[b.type];
                            }
                          )[0].downloadLink
                        }
                        layout="fill"
                      />
                    )}
                  </div>
                }
              />
            ));
          }}
          renderOption={(props, option: ISpeaker) => {
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
                  <Image
                    src={
                      option.images.sort((a: { type: keyof typeof sortOrder }, b: { type: keyof typeof sortOrder }) => {
                        return sortOrder[a.type] - sortOrder[b.type];
                      })[0].downloadLink
                    }
                    layout="fill"
                  />
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
        <TextField
          fullWidth
          id="scripture-input"
          label="Scripture"
          name="scripture"
          variant="outlined"
          value={sermon.scripture}
          onChange={handleChange}
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
            await fetchTopicsResults(value)
              .then((response) => response?.json())
              .then((data) => {
                const res: string[] = [];
                data.hits.forEach((element: any) => {
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
                  scripture: sermon.scripture,
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
                      scripture: sermon.scripture,
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
                  setUploadProgress(JSON.stringify(error));
                }
              } else if (user?.role !== 'admin') {
                setUploadProgress('You do not have permission to upload');
              }
            }}
          />
          <button type="button" className={styles.button} onClick={() => clearForm()}>
            Clear Form
          </button>
        </div>
      </Box>
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
              handleChange(e);
              !userHasTypedInSeries && setUserHasTypedInSeries(true);
            }}
            error={newSeriesError.error}
            label={newSeriesError.error ? newSeriesError.message : 'Series'}
          />
        </div>
      </DynamicPopUp>
      <p style={{ textAlign: 'center' }}>{uploadProgress}</p>
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
