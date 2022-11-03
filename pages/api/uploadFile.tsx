import firestore, { arrayUnion, deleteDoc, doc, setDoc, updateDoc } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, getDownloadURL } from '../../firebase/storage';
import { v4 as uuidv4 } from 'uuid';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { createSermon, sermonConverter } from '../../types/Sermon';

interface uploadFileProps {
  file: UploadableFile;
  setFile: Dispatch<SetStateAction<UploadableFile | undefined>>;

  setUploadProgress: Dispatch<SetStateAction<string | undefined>>;

  title: string;
  subtitle: string;
  date: Date;
  description: string;
  series: string;
  durationSeconds: number;
  speaker: Array<string>;
  scripture: string;
  topic: Array<string>;
  trimStart: number;
}

const uploadFile = async (props: uploadFileProps) => {
  const id = uuidv4();
  const sermonRef = ref(storage, `sermons/${id}`);

  if (props.series !== '') {
    const seriesRef = doc(firestore, 'series', props.series);
    try {
      await updateDoc(seriesRef, {
        sermonIds: arrayUnion(id),
      });
    } catch (err) {
      props.setUploadProgress(`Error: ${err}`);
    }
  }
  // const sermonRef = ref(storage, `sermons/${file.name}`);
  const metadata: UploadMetadata = {
    customMetadata: {
      startTime: props.trimStart.toString(),
      duration: props.durationSeconds.toString(),
      introUrl: await getDownloadURL(ref(storage, `intros/${props.subtitle}_intro.m4a`)),
      outroUrl: await getDownloadURL(ref(storage, `outros/${props.subtitle}_outro.m4a`)),
    },
  };
  const sermonData = createSermon({
    title: props.title,
    subtitle: props.subtitle,
    durationSeconds: props.durationSeconds,
    dateMillis: props.date.getTime(),
    description: props.description,
    series: props.series,
    speaker: props.speaker,
    scripture: props.scripture,
    topic: props.topic,
    key: sermonRef.name,
  });
  try {
    await setDoc(doc(firestore, 'sermons', id).withConverter(sermonConverter), sermonData);
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
      deleteDoc(doc(firestore, 'sermons', id)).catch((err) => {
        props.setUploadProgress(`Error: ${err}`);
      });
    },
    async () => {
      props.setUploadProgress('Uploaded!');
    }
  );
};
export default uploadFile;
