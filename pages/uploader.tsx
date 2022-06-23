/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import type { GetServerSideProps, NextPage } from 'next';

import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import AudioTrimmer from '../components/AudioTrimmer';
import uploadFile from './api/uploadFile';

import styles from '../styles/Uploader.module.css';
// import firebase from '../firebase/firebase';
// import { getFirestore, collection, addDoc } from 'firebase/firestore';
import { ChangeEvent, useCallback, useState } from 'react';
import { FileError, FileRejection, useDropzone } from 'react-dropzone';

import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker, LocalizationProvider } from '@mui/x-date-pickers';

import { getAuth } from 'firebase/auth';
import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';
import { Sermon, emptySermon } from '../types/Sermon';

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
}

const Uploader: NextPage<Props> = ({ speakers, topics }: Props) => {
  getAuth();
  const [sermonData, setSermonData] = useState<Sermon>(emptySermon);
  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date | null>(new Date());
  const [speaker, setSpeaker] = useState<Array<string>>([]);
  const [topic, setTopic] = useState<Array<string>>([]);

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
      <Navbar />
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
        <Autocomplete
          fullWidth
          value={speaker}
          onChange={(event: any, newValue: Array<string> | null) => {
            if (newValue !== null && newValue.length <= 3) {
              setSpeaker(newValue);
            }
          }}
          id="speaker-input"
          options={speakers}
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
          onChange={(event: any, newValue: Array<string> | null) => {
            if (newValue !== null && newValue.length <= 10) {
              setTopic(newValue);
            }
          }}
          id="topic-input"
          options={topics}
          multiple
          renderInput={(params) => <TextField {...params} label="Topic(s)" />}
        />
        <div className={styles.form}>
          {file ? (
            <>
              <AudioTrimmer url={file.preview}></AudioTrimmer>
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
                  date: date,
                  description: sermonData.description,
                  speaker: speakers,
                  scripture: sermonData.scripture,
                  topic: topics,
                });
              }
            }}
          />
          <p>{uploadProgress}</p>
        </div>
      </Box>
      <Footer />
    </form>
  );
};

// Uploader.propTypes = {
//   speakers: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
//   topics: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
// };

export const getServerSideProps: GetServerSideProps = async (context) => {
  interface speakerAndTopic {
    name: string;
  }

  const db = getFirestore(firebase);

  const speakersQuery = query(collection(db, 'speakers'));
  const speakers: Array<string> = [];
  const speakersQuerySnapshot = await getDocs(speakersQuery);
  speakersQuerySnapshot.forEach((doc) => {
    const current: speakerAndTopic = doc.data() as unknown as speakerAndTopic;
    speakers.push(current.name);
  });

  const topicsQuery = query(collection(db, 'topics'));
  const topics: Array<string> = [];
  const topicsQuerySnapshot = await getDocs(topicsQuery);
  topicsQuerySnapshot.forEach((doc) => {
    const current: speakerAndTopic = doc.data() as unknown as speakerAndTopic;
    topics.push(current.name);
  });
  return {
    props: { speakers: speakers, topics: topics },
  };
};

export default Uploader;
