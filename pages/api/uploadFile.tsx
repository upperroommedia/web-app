import firestore, { arrayUnion, deleteDoc, doc, setDoc, updateDoc } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, getDownloadURL } from '../../firebase/storage';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { Sermon, sermonConverter } from '../../types/Sermon';

interface uploadFileProps {
  file: UploadableFile;
  setFile: Dispatch<SetStateAction<UploadableFile | undefined>>;
  setUploadProgress: Dispatch<SetStateAction<string | undefined>>;
  date: Date;
  trimStart: number;
  sermon: Sermon;
}

const uploadFile = async (props: uploadFileProps) => {
  const sermonRef = ref(storage, `sermons/${props.sermon.key}`);

  if (props.sermon.series !== '') {
    const seriesRef = doc(firestore, 'series', props.sermon.series);
    try {
      await updateDoc(seriesRef, {
        sermonIds: arrayUnion(props.sermon.key),
      });
    } catch (err) {
      props.setUploadProgress(`Error: ${err}`);
    }
  }
  // const sermonRef = ref(storage, `sermons/${file.name}`);
  const metadata: UploadMetadata = {
    customMetadata: {
      startTime: props.trimStart.toString(),
      duration: props.sermon.durationSeconds.toString(),
      introUrl: await getDownloadURL(ref(storage, `intros/${props.sermon.subtitle}_intro.m4a`)),
      outroUrl: await getDownloadURL(ref(storage, `outros/${props.sermon.subtitle}_outro.m4a`)),
    },
  };
  try {
    await setDoc(doc(firestore, 'sermons', props.sermon.key).withConverter(sermonConverter), props.sermon);
  } catch (err) {
    props.setUploadProgress(`Error: ${err}`);
  }
  const uploadTask = uploadBytesResumable(sermonRef, props.file.file, metadata);

  uploadTask.on(
    'state_changed',
    (snapshot) => {
      const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
      props.setUploadProgress(`${Math.round(progress)}%`);
      switch (snapshot.state) {
        case 'paused':
          break;
        case 'running':
          break;
      }
    },
    (error) => {
      props.setUploadProgress(`Error: ${error}`);
      deleteDoc(doc(firestore, 'sermons', props.sermon.key)).catch((err) => {
        props.setUploadProgress(`Error: ${err}`);
      });
    },
    async () => {
      props.setUploadProgress('Uploaded!');
    }
  );
};
export default uploadFile;
