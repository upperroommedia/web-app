/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import dynamic from 'next/dynamic';
import uploadFile from './api/uploadFile';
import editSermon from './api/editSermon';
import addNewSeries from './api/addNewSeries';
import styles from '../styles/Uploader.module.css';
import { ChangeEvent, Dispatch, SetStateAction, useCallback, useEffect, useState } from 'react';
import { FileError, FileRejection, useDropzone } from 'react-dropzone';

import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';

import { collection, doc, getDoc, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';
import { Sermon, emptySermon, getDateString } from '../types/Sermon';

import Button from '@mui/material/Button';
import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import ProtectedRoute from '../components/ProtectedRoute';
import useAuth from '../context/user/UserContext';

const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });
const DynamicAudioTrimmer = dynamic(() => import('../components/AudioTrimmer'), { ssr: false });

export interface UploadableFile {
  file: File;
  name: string;
  preview: string;
  errors: FileError[];
}
// TODO: figure out how to type this properly
// let Url: {
//   new (url: string | URL, base?: string | URL | undefined): URL;
//   createObjectURL: any;
//   prototype?: URL;
//   revokeObjectURL?: (url: string) => void;
// };
let Url: any;
if (typeof window !== 'undefined') {
  Url = window.URL || window.webkitURL;
}
interface UploaderProps {
  existingSermon?: Sermon;
  setUpdatedSermon?: Dispatch<SetStateAction<Sermon>>;
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

const Uploader = (props: UploaderProps & InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const { user } = useAuth();
  const [sermonData, setSermonData] = useState<Sermon>(props.existingSermon ? props.existingSermon : emptySermon);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();
  const [duration, setDuration] = useState<number>(0);

  const [subtitlesArray, setSubtitlesArray] = useState<string[]>([]);
  const [seriesArray, setSeriesArray] = useState<string[]>([]);
  const [speakersArray, setSpeakersArray] = useState<string[]>([]);
  const [topicsArray, setTopicsArray] = useState<string[]>([]);

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date>(new Date(props.existingSermon ? props.existingSermon.dateMillis : new Date()));
  const [speaker, setSpeaker] = useState(props.existingSermon ? props.existingSermon.speaker : []);
  const [topic, setTopic] = useState(props.existingSermon ? props.existingSermon.topic : []);
  const [series, setSeries] = useState(props.existingSermon ? props.existingSermon.series : '');

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
      const db = getFirestore(firebase);

      const subtitlesRef = doc(db, 'subtitles', 'subtitlesDoc');
      const subtitlesSnap = await getDoc(subtitlesRef);
      const subtitlesData = subtitlesSnap.data();
      setSubtitlesArray(subtitlesData ? subtitlesSnap.data()?.subtitlesArray : []);

      const seriesQuery = query(collection(db, 'series'));
      const seriesQuerySnapshot = await getDocs(seriesQuery);
      setSeriesArray(seriesQuerySnapshot.docs.map((doc) => doc.data().name));

      const topicsRef = doc(db, 'topics', 'topicsDoc');
      const topicsSnap = await getDoc(topicsRef);
      const topicsData = topicsSnap.data();
      setTopicsArray(topicsData ? topicsSnap.data()?.topicsArray : []);
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
      sermon1.series === series &&
      JSON.stringify(sermon1.speaker) === JSON.stringify(speaker) &&
      sermon1.scripture === sermon2.scripture &&
      JSON.stringify(sermon1.topic) === JSON.stringify(topic)
    );
  };

  const onDrop = useCallback((acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
    // Do something with the files
    if (rejectedFiles.length > 0) {
      // console.log(rejectedFiles[0].errors[0]);
      setFile(undefined);
      return;
    }
    // const reader = new FileReader();
    // reader.readAsDataURL(acceptedFiles[0]);
    // reader.addEventListener('progress', function (pe) {
    //   if (pe.lengthComputable) {
    //     console.log('Progress:', pe.loaded, 'Total:', pe.total);
    //   }
    // });
    // reader.addEventListener(
    //   'load',
    //   function () {
    const mappedAccepted = {
      file: acceptedFiles[0],
      // preview: reader.result as string,
      preview: Url.createObjectURL(acceptedFiles[0]),
      name: acceptedFiles[0].name.replace(/\.[^/.]+$/, ''),
      errors: [],
    };
    setFile(mappedAccepted);
    //   },
    //   false
    // );
    // const mappedAccepted2 = acceptedFiles.map((file) => ({
    //   file,
    //   errors: [],
    // }));
    // setFile((curr) => [...curr, mappedAccepted, ...rejectedFiles]);
  }, []);

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    multiple: false,
    accept: { 'audio/*': ['.mp3', '.wav', '.flac'] },
  });

  const clearForm = () => {
    setSpeakerError({ error: false, message: '' });
    setTopicError({ error: false, message: '' });
    setSermonData(emptySermon);
    setDate(new Date());
    setSpeaker([]);
    setTopic([]);
    setSeries('');
    setFile(undefined);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSermonData((prevSermonData) => {
      return {
        ...prevSermonData,
        [event.target.name]: event.target.value,
      };
    });
  };

  const handleDateChange = (newValue: Date) => {
    setDate(newValue);
  };

  const fetchSpeakerResults = async (query: string) => {
    if (process.env.NEXT_PUBLIC_ALGOLIA_API_KEY && process.env.NEXT_PUBLIC_ALGOLIA_APP_ID) {
      const url = `https://${process.env.NEXT_PUBLIC_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/speakers_index/query`;
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
          value={sermonData.title}
          onChange={handleChange}
          required
        />
        <Box sx={{ display: 'flex', color: 'red', gap: '1ch', width: 1 }}>
          <Autocomplete
            fullWidth
            id="subtitle-input"
            value={sermonData.subtitle || null}
            onChange={(_, newValue) => {
              newValue === null
                ? setSermonData((oldSermonData) => ({
                    ...oldSermonData,
                    subtitle: '',
                  }))
                : setSermonData((oldSermonData) => ({
                    ...oldSermonData,
                    subtitle: newValue,
                  }));
            }}
            renderInput={(params) => <TextField required {...params} label="Subtitle" />}
            options={subtitlesArray}
          />
          <LocalizationProvider dateAdapter={AdapterDateFns} sx={{ width: 1 }} fullWidth>
            {/* TODO: Use date invalid for disabling the button */}
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
          value={sermonData.description}
          onChange={handleChange}
        />
        <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
          <Autocomplete
            fullWidth
            value={series || null}
            onChange={(_, newValue) => {
              newValue === null ? setSeries('') : setSeries(newValue);
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
          value={speaker}
          onBlur={() => {
            setSpeakerError({ error: false, message: '' });
          }}
          onChange={(_, newValue) => {
            if (newValue !== null && newValue.length <= 3) {
              setSpeaker(newValue);
            } else if (newValue.length >= 4) {
              setSpeakerError({
                error: true,
                message: 'Can only add up to 3 speakers',
              });
            }
          }}
          onInputChange={async (_, value) => {
            // setSpeakersArray([]);
            await fetchSpeakerResults(value)
              .then((response) => response?.json())
              .then((data) => {
                const res: string[] = [];
                data.hits.forEach((element: any) => {
                  res.push(element.name);
                });
                setSpeakersArray(res);
              });
          }}
          id="speaker-input"
          options={speakersArray}
          multiple
          renderInput={(params) => (
            <TextField
              {...params}
              required
              label="Speaker(s)"
              error={speakerError.error}
              helperText={speakerError.message}
            />
          )}
        />
        <TextField
          fullWidth
          id="scripture-input"
          label="Scripture"
          name="scripture"
          variant="outlined"
          value={sermonData.scripture}
          onChange={handleChange}
        />
        <Autocomplete
          fullWidth
          value={topic}
          onBlur={() => {
            setTopicError({ error: false, message: '' });
          }}
          onChange={(_, newValue) => {
            if (newValue !== null && newValue.length <= 10) {
              setTopic(newValue);
            } else if (newValue.length >= 11) {
              setTopicError({
                error: true,
                message: 'Can only add up to 10 topics',
              });
            }
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
                  key: sermonData.key,
                  title: sermonData.title,
                  subtitle: sermonData.subtitle,
                  date,
                  description: sermonData.description,
                  speaker,
                  scripture: sermonData.scripture,
                  topic,
                  series,
                }).then(() => {
                  props.setUpdatedSermon?.({
                    key: sermonData.key,
                    title: sermonData.title,
                    subtitle: sermonData.subtitle,
                    dateMillis: date.getTime(),
                    durationSeconds: sermonData.durationSeconds,
                    description: sermonData.description,
                    speaker,
                    scripture: sermonData.scripture,
                    topic,
                    series,
                    dateString: getDateString(date),
                  });
                  props.setEditFormOpen?.(false);
                })
              }
              disabled={
                sermonsEqual(props.existingSermon, sermonData) ||
                sermonData.title === '' ||
                date === null ||
                speaker.length === 0 ||
                sermonData.subtitle === ''
              }
              variant="contained"
            >
              update sermon
            </Button>
          </div>
        ) : (
          <div className={styles.form}>
            {file ? (
              <>
                <DynamicAudioTrimmer url={file.preview} duration={duration} setDuration={setDuration} />
                <div style={{ display: 'flex' }}>
                  <button type="button" className={styles.button} onClick={() => setFile(undefined)}>
                    Clear File
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.dragAndDrop} {...getRootProps()}>
                <input type="hidden" {...getInputProps()} />
                <p>Drag &apos;n&apos; drop audio files here, or click to select files</p>
              </div>
            )}
            <div style={{ display: 'flex' }}>
              <input
                className={styles.button}
                type="button"
                value="Upload"
                disabled={
                  file === undefined ||
                  sermonData.title === '' ||
                  date === null ||
                  speaker.length === 0 ||
                  sermonData.subtitle === ''
                }
                onClick={async () => {
                  if (file !== undefined && date != null && user?.role === 'admin') {
                    try {
                      await uploadFile({
                        file: file,
                        setFile: setFile,
                        setUploadProgress: setUploadProgress,
                        title: sermonData.title,
                        subtitle: sermonData.subtitle,
                        durationSeconds: duration,
                        date,
                        description: sermonData.description,
                        speaker,
                        scripture: sermonData.scripture,
                        topic,
                        series,
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
          </div>
        )}
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
                setSeries(newSeries);
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
