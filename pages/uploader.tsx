/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import type {
  GetServerSideProps,
  NextPage,
  InferGetServerSidePropsType,
  GetServerSidePropsContext,
} from 'next';

import AudioTrimmer from '../components/AudioTrimmer';
import uploadFile from './api/uploadFile';
import addNewSeries from './api/addNewSeries';
import PopUp from '../components/PopUp';

import styles from '../styles/Uploader.module.css';
import { ChangeEvent, useCallback, useState } from 'react';
import { FileError, FileRejection, useDropzone } from 'react-dropzone';

import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker, LocalizationProvider } from '@mui/x-date-pickers';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';

import { getAuth } from 'firebase/auth';
import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';
import { Sermon, emptySermon } from '../types/Sermon';

import ProtectedRoute from '../components/ProtectedRoute';
import Button from '@mui/material/Button';

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
interface Props {
  speakers: Array<string>;
  topics: Array<string>;
  seriesArray: Array<string>;
}

const Uploader: NextPage<Props> = (
  props: InferGetServerSidePropsType<typeof getServerSideProps>
) => {
  getAuth();
  const [sermonData, setSermonData] = useState<Sermon>(emptySermon);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();
  const [duration, setDuration] = useState<number>(0);

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date | null>(new Date());
  const [speaker, setSpeaker] = useState([]);
  const [topic, setTopic] = useState([]);

  const [series, setSeries] = useState();

  const [newSeries, setNewSeries] = useState<string>('');
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
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
    },
    []
  );

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    multiple: false,
    accept: ['audio/*'],
  });

  const clearForm = () => {
    setSermonData(emptySermon);
    setDate(new Date());
    setSpeaker([]);
    setTopic([]);
  };

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setSermonData((prevSermonData) => {
      return {
        ...prevSermonData,
        [event.target.name]: event.target.value,
      };
    });
  }

  const handleDateChange = (newValue: Date | null) => {
    setDate(newValue);
  };

  return (
    <form className={styles.container}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          padding: '2rem',
          gap: '1ch',
          margin: 'auto',
          maxWidth: '900px',
        }}
      >
        <h1>Uploader</h1>
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
          <TextField
            fullWidth
            id="title-input"
            label="Subtitle"
            name="subtitle"
            variant="outlined"
            value={sermonData.subtitle}
            onChange={handleChange}
          />
          <LocalizationProvider
            dateAdapter={AdapterDateFns}
            sx={{ width: 1 }}
            fullWidth
          >
            {/* TODO: Use date invalid for disabling the button */}
            <DesktopDatePicker
              label="Date"
              inputFormat="MM/dd/yyyy"
              value={date}
              onChange={handleDateChange}
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
            onChange={(event: any, newValue: any | null) => {
              if (newValue !== null) {
                setSeries(newValue);
              }
            }}
            id="series-input"
            options={props.seriesArray}
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
          onChange={(event: any, newValue: any | null) => {
            if (newValue !== null && newValue.length <= 3) {
              setSpeaker(newValue);
            }
          }}
          id="speaker-input"
          options={props.speakers}
          multiple
          renderInput={(params) => (
            <TextField {...params} required label="Speaker(s)" />
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
          onChange={(event: any, newValue: any | null) => {
            if (newValue !== null && newValue.length <= 10) {
              setTopic(newValue);
            }
          }}
          id="topic-input"
          options={props.topics}
          multiple
          renderInput={(params) => <TextField {...params} label="Topic(s)" />}
        />
        <div className={styles.form}>
          {file ? (
            <>
              <AudioTrimmer
                url={file.preview}
                duration={duration}
                setDuration={setDuration}
              ></AudioTrimmer>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setFile(undefined);
                  setUploadProgress(undefined);
                  clearForm();
                }}
              >
                Clear
              </button>
            </>
          ) : (
            <div className={styles.dragAndDrop} {...getRootProps()}>
              <input type="hidden" {...getInputProps()} />
              <p>
                Drag &apos;n&apos; drop audio files here, or click to select
                files
              </p>
            </div>
          )}
          <input
            className={styles.button}
            type="button"
            value="Upload"
            disabled={
              file === undefined ||
              sermonData.title === '' ||
              date === null ||
              speaker.length === 0
            }
            // TODO: Clear the form when upload is complete also remove upload button when it is uploading as to prevent
            // the user from double clicking upload
            onClick={() => {
              if (file !== undefined && date != null) {
                uploadFile({
                  file: file,
                  setFile: setFile,
                  setUploadProgress: setUploadProgress,
                  title: sermonData.title,
                  subtitle: sermonData.subtitle,
                  durationSeconds: duration,
                  date: date,
                  description: sermonData.description,
                  speaker: props.speakers,
                  scripture: sermonData.scripture,
                  topic: props.topics,
                });
              }
            }}
          />
          <p>{uploadProgress}</p>
        </div>
      </Box>
      <PopUp
        title={'Add new series'}
        open={newSeriesPopup}
        setOpen={() => setNewSeriesPopup(false)}
      >
        <div style={{ display: 'flex' }}>
          <TextField
            value={newSeries}
            onChange={(e) => {
              setNewSeries(e.target.value);
            }}
          />
          <Button
            disabled={newSeries === ''}
            onClick={() => {
              addNewSeries(newSeries).then(() => setNewSeriesPopup(false));
              props.seriesArray.push(newSeries);
              setNewSeries('');
            }}
          >
            Submit
          </Button>
        </div>
      </PopUp>
    </form>
  );
};

// Uploader.propTypes = {
//   speakers: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
//   topics: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
// };

interface field {
  name: string;
}

export const getServerSideProps: GetServerSideProps = async (
  ctx: GetServerSidePropsContext
) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.token) {
    const failedUserCredentials = userCredentials;
    return failedUserCredentials;
  }

  const db = getFirestore(firebase);

  const speakersQuery = query(collection(db, 'speakers'));
  const speakers: Array<string> = [];
  const speakersQuerySnapshot = await getDocs(speakersQuery);
  speakersQuerySnapshot.forEach((doc) => {
    const current: field = doc.data() as unknown as field;
    speakers.push(current.name);
  });

  const topicsQuery = query(collection(db, 'topics'));
  const topics: Array<string> = [];
  const topicsQuerySnapshot = await getDocs(topicsQuery);
  topicsQuerySnapshot.forEach((doc) => {
    const current: field = doc.data() as unknown as field;
    topics.push(current.name);
  });

  const seriesQuery = query(collection(db, 'series'));
  const series: Array<string> = [];
  const seriesQuerySnapshot = await getDocs(seriesQuery);
  seriesQuerySnapshot.forEach((doc) => {
    const current: field = doc.data() as unknown as field;
    series.push(current.name);
  });

  return {
    props: {
      speakers: speakers,
      topics: topics,
      seriesArray: series,
    },
  };
};

export default Uploader;
