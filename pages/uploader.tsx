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

import Box from '@mui/material/Box';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Select, { SelectChangeEvent } from '@mui/material/Select';

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

const Uploader: NextPage<{ speakers: Array<string> }> = ({ speakers }) => {
  getAuth();

  const [file, setFile] = useState<UploadableFile>();
  const [uploadProgress, setUploadProgress] = useState<string>();

  const [title, setTitle] = useState<string>('');
  const [subtitle, setSubtitle] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [speaker, setSpeaker] = useState<string>('');
  const [scripture, setScripture] = useState<string>('');
  const [topic, setTopic] = useState<string>('');

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
    setSpeaker('');
    setScripture('');
    setTopic('');
  };

  const handleSpeakerChange = (event: SelectChangeEvent) => {
    setSpeaker(event.target.value as string);
  };

  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Uploader</h1>
      <form>
        <label>
          Title:
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="required"
          />
        </label>
        <label>
          Subtitle:
          <input
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
          />
        </label>
        <label>
          Date:
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          Description:
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <Box sx={{ maxWidth: 120 }}>
          <FormControl required fullWidth>
            <InputLabel id="demo-simple-select-label">Speaker</InputLabel>
            <Select
              labelId="demo-simple-select-label"
              id="demo-simple-select"
              value={speaker}
              label="Speaker"
              onChange={handleSpeakerChange}
            >
              {speakers.map((speaker) => {
                return (
                  <MenuItem key={speaker} value={speaker}>
                    {speaker}
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
        </Box>
        <label>
          Scripture:
          <input
            type="text"
            value={scripture}
            onChange={(e) => setScripture(e.target.value)}
          />
        </label>
        <label>
          Topic:
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
      </form>
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
            file === undefined || title === '' || date === '' || speaker === ''
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
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  interface Speaker {
    name: string;
  }
  const db = getFirestore(firebase);
  const q = query(collection(db, 'speakers'));
  const speakers: Array<string> = [];
  const querySnapshot = await getDocs(q);
  querySnapshot.forEach((doc) => {
    const current: Speaker = doc.data() as unknown as Speaker;
    speakers.push(current.name);
  });
  return {
    props: { speakers: speakers },
  };
};

export default Uploader;
