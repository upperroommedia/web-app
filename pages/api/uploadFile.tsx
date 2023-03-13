import firestore, { arrayUnion, deleteDoc, doc, runTransaction, setDoc } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, getDownloadURL } from '../../firebase/storage';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { seriesConverter } from '../../types/Series';

interface uploadFileProps {
  file: UploadableFile;
  setFile: Dispatch<SetStateAction<UploadableFile | undefined>>;
  setUploadProgress: Dispatch<SetStateAction<{ error: boolean; message: string }>>;
  trimStart: number;
  sermon: Sermon;
}

const uploadFile = async (props: uploadFileProps) => {
  const sermonRef = ref(storage, `sermons/${props.sermon.key}`);

  // const sermonRef = ref(storage, `sermons/${file.name}`);
  const metadata: UploadMetadata = {
    customMetadata: {
      startTime: props.trimStart.toString(),
      duration: props.sermon.durationSeconds.toString(),
      introUrl: await getDownloadURL(ref(storage, `intros/${props.sermon.subtitle}_intro.m4a`)),
      outroUrl: await getDownloadURL(ref(storage, `outros/${props.sermon.subtitle}_outro.m4a`)),
    },
  };
  props.sermon.images = await Promise.all(
    props.sermon.images.map(async (image): Promise<ImageType> => {
      if (!image.subsplashId) {
        // TODO[1] Upload image to subsplash and get subsplashId
        throw new Error('Image does not have subsplashId please fix this before uploading');
      }
      return image;
    })
  );
  await setDoc(doc(firestore, 'sermons', props.sermon.key).withConverter(sermonConverter), props.sermon);
  const uploadTask = uploadBytesResumable(sermonRef, props.file.file, metadata);

  uploadTask.on(
    'state_changed',
    (snapshot) => {
      const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
      props.setUploadProgress({ error: false, message: `${Math.round(progress)}%` });
      switch (snapshot.state) {
        case 'paused':
          break;
        case 'running':
          break;
      }
    },
    async (error) => {
      await deleteDoc(doc(firestore, 'sermons', props.sermon.key));
      throw error;
    },
    async () => {
      props.setUploadProgress({ error: false, message: 'Uploaded!' });
      runTransaction(firestore, async (transaction) => {
        props.sermon.series.forEach((s) => {
          const seriesRef = doc(firestore, 'series', s.id).withConverter(seriesConverter);
          transaction.update(seriesRef, { allSermons: arrayUnion(props.sermon) });
        });
      });
    }
  );
};
export default uploadFile;
