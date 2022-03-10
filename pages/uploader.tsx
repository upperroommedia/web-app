/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
 import type { NextPage } from 'next';
 import Footer from '../components/Footer';
 import Navbar from '../components/Navbar';
 import AudioTrimmer from '../components/AudioTrimmer';
 import styles from '../styles/Uploader.module.css';
 // import firebase from '../firebase/firebase';
 // import { getFirestore, collection, addDoc } from 'firebase/firestore';
 import { useCallback, useState } from 'react';
 import { FileError, FileRejection, useDropzone } from 'react-dropzone';
 
 import { ref, uploadBytes } from 'firebase/storage';
 import { storage } from '../firebase/firebase';
 import { getAuth } from 'firebase/auth';
 
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
 
   function uploadFile(file: File) {
     const sermonRef = ref(storage, `sermons/${file.name}`);
     getAuth();
     uploadBytes(sermonRef, file).then((snapshot) => {});
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
           <>
             <AudioTrimmer url={file.preview}></AudioTrimmer>
             <button
               type="button"
               className={styles.button}
               onClick={() => setFile(undefined)}
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
           // type="submit"
           value="Upload"
           disabled={file === undefined}
           onClick={() => {
             if (file !== undefined) {
               uploadFile(file.file);
             }
           }}
         />
       </form>
       <Footer />
     </div>
   );
 };
 
 export default Uploader;
 