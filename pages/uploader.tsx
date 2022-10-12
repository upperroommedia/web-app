/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import AudioTrimmer from '../components/AudioTrimmer';
import uploadFile from './api/uploadFile';
import editSermon from './api/editSermon';
import addNewSeries from './api/addNewSeries';
import PopUp from '../components/PopUp';

import styles from '../styles/Uploader.module.css';
import { ChangeEvent, Dispatch, SetStateAction, useEffect, useState } from 'react';

import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker, LocalizationProvider } from '@mui/x-date-pickers';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';
import Cancel from '@mui/icons-material/Cancel';

import { collection, doc, getDoc, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';
import { Sermon, emptySermon, getDateString } from '../types/Sermon';

import Button from '@mui/material/Button';
import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import ProtectedRoute from '../components/ProtectedRoute';
import useAuth from '../context/user/UserContext';
import DropZone, { UploadableFile } from '../components/DropZone';

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

      const speakersQuery = query(collection(db, 'speakers'));
      const speakersQuerySnapshot = await getDocs(speakersQuery);
      setSpeakersArray(speakersQuerySnapshot.docs.map((doc) => doc.data().name));

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
              disabled={sermonsEqual(props.existingSermon, sermonData)}
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
                <AudioTrimmer url={file.preview} duration={duration} setDuration={setDuration} />
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
      </Box>
      <PopUp
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
      </PopUp>
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
