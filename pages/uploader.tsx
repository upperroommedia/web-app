/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import type { GetServerSideProps, NextPage } from 'next';
import PropTypes from 'prop-types';

import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import AudioTrimmer from '../components/AudioTrimmer';

import uploadFile from './api/uploadFile';

import styles from '../styles/Uploader.module.css';
// import firebase from '../firebase/firebase';
// import { getFirestore, collection, addDoc } from 'firebase/firestore';
import { useCallback, useState } from 'react';
import { FileError, FileRejection, useDropzone } from 'react-dropzone';

import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';

import { getAuth } from 'firebase/auth';
import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';

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

const Uploader: NextPage<{
  speakers: Array<string>;
  topics: Array<string>;
}> = ({ speakers, topics }) => {
  getAuth();

  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();

  const [title, setTitle] = useState<string>('');
  const [subtitle, setSubtitle] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [speaker, setSpeaker] = useState<Array<string>>([]);
  const [scripture, setScripture] = useState<string>('');
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
    setTitle('');
    setSubtitle('');
    setDate('');
    setDescription('');
    setSpeaker([]);
    setScripture('');
    setTopic([]);
  };

  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Uploader</h1>
      <TextField
        id="title-input"
        label="Title"
        variant="outlined"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <TextField
        id="title-input"
        label="Subtitle"
        variant="outlined"
        value={subtitle}
        onChange={(e) => setSubtitle(e.target.value)}
      />
      <label>
        Date:
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <TextField
        id="description-text"
        label="Description"
        placeholder="Description"
        multiline
        onChange={(e) => setDescription(e.target.value)}
      />
      <Autocomplete
        value={speaker === [] ? undefined : speaker}
        onChange={(event: any, newValue: Array<string> | null) => {
          if (newValue !== null && newValue.length <= 3) {
            setSpeaker(newValue);
          }
        }}
        id="speaker-input"
        options={speakers}
        multiple
        sx={{ width: 200 }}
        renderInput={(params) => (
          <TextField {...params} required label="Speaker(s)" />
        )}
      />
      <TextField
        id="scripture-input"
        label="Scripture"
        variant="outlined"
        value={scripture}
        onChange={(e) => setScripture(e.target.value)}
      />
      <Autocomplete
        value={topic === [] ? undefined : topic}
        onChange={(event: any, newValue: Array<string> | null) => {
          if (newValue !== null && newValue.length <= 10) {
            setTopic(newValue);
          }
        }}
        id="topic-input"
        options={topics}
        multiple
        sx={{ width: 200 }}
        renderInput={(params) => (
          <TextField {...params} required label="Topic(s)" />
        )}
      />
      <form className={styles.form}>
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
              Drag &apos;n&apos; drop audio files here, or click to select files
            </p>
          </div>
        )}
        <input
          className={styles.button}
          type="button"
          value="Upload"
          disabled={
            file === undefined || title === '' || date === '' || speaker === []
          }
          onClick={() => {
            if (file !== undefined) {
              uploadFile({
                file,
                setFile,
                setUploadProgress,
                title,
                subtitle,
                date,
                description,
                speaker,
                scripture,
                topic,
              });
            }
          }}
        />
        <p>{uploadProgress}</p>
      </form>
      <Footer />
    </div>
  );
};

Uploader.propTypes = {
  speakers: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
  topics: PropTypes.arrayOf(PropTypes.string.isRequired).isRequired,
};

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
