/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import type { NextPage } from 'next';
import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import styles from '../styles/Uploader.module.css';
// import firebase from '../firebase/firebase';
// import { getFirestore, collection, addDoc } from 'firebase/firestore';
import { useCallback, useState } from 'react';
import { FileError, FileRejection, useDropzone } from 'react-dropzone';

export interface UploadableFile {
  file: File;
  errors: FileError[];
}

const Uploader: NextPage = () => {
  // const db = getFirestore(firebase);
  const [file, setFile] = useState<UploadableFile[]>([]);
  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      // Do something with the files
      const mappedAccepted = [{ file: acceptedFiles[0], errors: [] }];
      // const mappedAccepted2 = acceptedFiles.map((file) => ({
      //   file,
      //   errors: [],
      // }));
      // setFile((curr) => [...curr, mappedAccepted, ...rejectedFiles]);
      setFile(rejectedFiles.length > 0 ? rejectedFiles : mappedAccepted);
    },
    []
  );

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    multiple: false,
    accept: 'audio/*',
  });

  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Uploader</h1>
      <form className={styles.form}>
        <div className={styles.dragAndDrop} {...getRootProps()}>
          <input {...getInputProps} />
          {/* eslint-disable-next-line react/no-unescaped-entities */}
          <p>Drag 'n' drop audio files here, or click to select files</p>
        </div>
        {JSON.stringify(file)}
        <input type="submit" value="Upload" />
      </form>
      <Footer />
    </div>
  );
};

export default Uploader;
