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
  const [file, setFile] = useState<UploadableFile>();
  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      // Do something with the files
      if (rejectedFiles.length > 0) {
        // console.log(rejectedFiles[0].errors[0]);
        setFile(undefined);
        return;
      }
      const mappedAccepted = { file: acceptedFiles[0], errors: [] };
      setFile(mappedAccepted);
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
    accept: 'audio/*',
  });

  function uploadFile(file: File) {
    // console.log('Upload File', file);
    // const url = '...';
    // return await new Promise((res, rej) => {
    //   const xhr = new XMLHttpRequest();
    //   xhr.open('POST', url);
    //   xhr.onload = () => {
    //     res('00')
    //   }
    //   xhr.onerror = (evt) => rej(evt);
    //   xhr.upload.onprogress = (event) => {
    //     if (event.lengthComputable) {
    //       const percentage = (event.loaded / event.total) * 100;
    //       onProgress(Math.round(percentage))
    //     }
    //   };
    //   const formData = new FormData();
    //   formData.append('file', file);
    //   formData.append('key', key)
    //   xhr.send(formData)
    // });
  }

  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Uploader</h1>
      <form className={styles.form}>
        {file ? (
          <span>
            <p>{JSON.stringify(file)}</p>
            <button onClick={() => setFile(undefined)}>Clear</button>
          </span>
        ) : (
          <div className={styles.dragAndDrop} {...getRootProps()}>
            <input {...getInputProps} />
            <p>
              Drag &apos;n&apos; drop audio files here, or click to select files
            </p>
          </div>
        )}
        <input
          type="submit"
          value="Upload"
          disabled={file === undefined}
          onClick={() => {
            if (file !== undefined) {
              uploadFile(file.file);
            }
          }}
          // onClick={uploadFile(file?.file)}
        />
      </form>
      <Footer />
    </div>
  );
};

export default Uploader;
