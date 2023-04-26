import firestore, { deleteDoc, doc, setDoc, writeBatch } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, getDownloadURL } from '../../firebase/storage';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { List } from '../../types/List';

interface uploadFileProps {
  file: UploadableFile;
  setUploadProgress: Dispatch<SetStateAction<{ error: boolean; message: string; percent: number }>>;
  trimStart: number;
  sermon: Sermon;
  sermonList: List[];
}

const uploadFile = async (props: uploadFileProps) => {
  // console.info(`uploading sermon ${props.sermon.title} with key ${props.sermon.id}`);
  const sermonRef = ref(storage, `sermons/${props.sermon.id}`);

  // const sermonRef = ref(storage, `sermons/${file.name}`);
  let introRef = '';
  let outroRef = '';
  try {
    introRef = await getDownloadURL(ref(storage, `intros/${props.sermon.subtitle}_intro.mp3`));
  } catch (error) {
    try {
      introRef = await getDownloadURL(ref(storage, `intros/default_intro.mp3`));
    } catch (error) {
      throw new Error(
        'Could not find intro audio for sermon: you must have a file called "default_intro.mp3" in your storage bucket'
      );
    }
  }
  try {
    outroRef = await getDownloadURL(ref(storage, `outros/${props.sermon.subtitle}_outro.mp3`));
  } catch (error) {
    try {
      outroRef = await getDownloadURL(ref(storage, `outros/default_outro.mp3`));
    } catch (error) {
      throw new Error(
        'Could not find outro audio for sermon: you must have a file called "default_outro.mp3" in your storage bucket'
      );
    }
  }
  const metadata: UploadMetadata = {
    customMetadata: {
      startTime: props.trimStart.toString(),
      duration: props.sermon.durationSeconds.toString(),
      introUrl: introRef,
      outroUrl: outroRef,
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
  await setDoc(doc(firestore, 'sermons', props.sermon.id).withConverter(sermonConverter), props.sermon);
  await new Promise<void>((resolve, reject) => {
    uploadBytesResumable(sermonRef, props.file.file, metadata).on(
      'state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        props.setUploadProgress({ error: false, percent: Math.round(progress), message: 'Uploading...' });
        switch (snapshot.state) {
          case 'paused':
            break;
          case 'running':
            break;
        }
      },
      async (error) => {
        await deleteDoc(doc(firestore, 'sermons', props.sermon.id));
        reject(error);
      },
      async () => {
        resolve();
        // add sermon to series
        // note a firestore function document listener will take care of updating the series subcollection for the sermon
        const batch = writeBatch(firestore);
        props.sermonList.forEach((list) => {
          const seriesSermonRef = doc(firestore, 'lists', list.id, 'listItems', props.sermon.id);
          batch.set(seriesSermonRef, props.sermon);
        });
        batch.commit();
        props.setUploadProgress({ error: false, message: 'Uploaded!', percent: 100 });
      }
    );
  });
};
export default uploadFile;
