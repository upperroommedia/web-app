import firestore, { deleteDoc, doc, writeBatch } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, deleteObject } from '../../firebase/storage';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { List } from '../../types/List';
import { createFunctionV2 } from '../../utils/createFunction';
import { AddIntroOutroInputType } from '../../functions/src/addIntroOutro/types';
import { getIntroAndOutro } from '../../utils/uploadUtils';

interface uploadFileProps {
  file: UploadableFile;
  setUploadProgress: Dispatch<SetStateAction<{ error: boolean; message: string; percent: number }>>;
  trimStart: number;
  sermon: Sermon;
  sermonList: List[];
}

const uploadFile = async (props: uploadFileProps) => {
  const sermonRef = ref(storage, `sermons/${props.sermon.id}`);
  const { introRef, outroRef } = await getIntroAndOutro(props.sermon);
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
        // eslint-disable-next-line no-console
        console.error(error);
        props.setUploadProgress({ error: true, message: `Error uploading file: ${JSON.stringify(error)}`, percent: 0 });
        await deleteDoc(doc(firestore, 'sermons', props.sermon.id));
        reject(error);
      },
      async () => {
        // add sermon to series
        // note a firestore function document listener will take care of updating the series subcollection for the sermon
        const batch = writeBatch(firestore);
        batch.set(doc(firestore, 'sermons', props.sermon.id).withConverter(sermonConverter), props.sermon);
        props.sermonList.forEach((list) => {
          const seriesSermonRef = doc(firestore, 'lists', list.id, 'listItems', props.sermon.id);
          batch.set(seriesSermonRef, props.sermon);
        });
        await batch.commit();
        props.setUploadProgress({ error: false, message: 'Uploaded!', percent: 100 });
        try {
          const generateAddIntroOutroTask = createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
          const data: AddIntroOutroInputType = {
            storageFilePath: sermonRef.fullPath,
            startTime: props.trimStart,
            duration: props.sermon.durationSeconds,
            deleteOriginal: true,
            introUrl: introRef,
            outroUrl: outroRef,
          };
          await generateAddIntroOutroTask(data);
          resolve();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Error generatingAddIntroOutroTask', e);
          props.setUploadProgress({ error: true, message: `${JSON.stringify(e)}`, percent: 0 });
          await Promise.all([deleteDoc(doc(firestore, 'sermons', props.sermon.id)), deleteObject(sermonRef)]);
          reject(e);
        }
      }
    );
  });
};
export default uploadFile;
