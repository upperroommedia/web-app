import firestore, { deleteDoc, doc, writeBatch, getDocs, query, collection, orderBy, limit } from '../../firebase/firestore';
import storage, { ref, uploadBytesResumable, UploadMetadata, deleteObject } from '../../firebase/storage';

import { Dispatch, SetStateAction } from 'react';
import { UploadableFile } from '../../components/DropZone';
import { sermonConverter } from '../../types/Sermon';
import { Sermon, uploadStatus } from '../../types/SermonTypes';
import { ImageType } from '../../types/Image';
import { List } from '../../types/List';
import { sermonListConverter } from '../../types/SermonList';
import { createFunctionV2 } from '../../utils/createFunction';
import { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { getIntroAndOutro } from '../../utils/uploadUtils';
import { UploadProgress } from '../../context/types';
import { createOperationKey } from '../../utils/callableConcurrency';

export type AudioSource =
  | {
      type: 'YoutubeUrl';
      source: string;
    }
  | {
      type: 'File';
      source: UploadableFile;
    };

type UploadFileProps = {
  audioSource: AudioSource;
  setUploadProgress: Dispatch<SetStateAction<UploadProgress>>;
  trimStart: number;
  sermon: Sermon;
  sermonList: List[];
};

const addFirestoreDocument = async (
  sermon: Sermon,
  sermonList: List[],
  setUploadProgress: Dispatch<SetStateAction<UploadProgress>>
) => {
  const batch = writeBatch(firestore);
  batch.set(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter), {
    ...sermon,
    searchPending: true,
    searchIndexedAtMillis: undefined,
    searchSyncError: undefined,
  });
  
  // Add sermon to list subcollections
  sermonList.forEach((list) => {
    const listItemRef = doc(firestore, 'lists', list.id, 'listItems', sermon.id);
    batch.set(listItemRef, sermon);
    const sermonListRef = doc(firestore, 'sermons', sermon.id, 'sermonLists', list.id).withConverter(sermonListConverter);
    batch.set(sermonListRef, {
      ...list,
      uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      publishGeneration: 0,
    });
  });
  
  // Add sermon to series subcollection if seriesId is set
  if (sermon.seriesId) {
    const latestPositionSnapshot = await getDocs(
      query(
        collection(firestore, `series/${sermon.seriesId}/seriesItems`),
        orderBy('position', 'desc'),
        limit(1)
      )
    );
    const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
    const newPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;
    const seriesItemRef = doc(firestore, 'series', sermon.seriesId, 'seriesItems', sermon.id);
    batch.set(seriesItemRef, {
      id: sermon.id,
      position: newPosition,
      publishedToSubsplash: false,
      sermonSubsplashId: sermon.subsplashId || null,
      addedAt: new Date(),
    });
  }
  
  await batch.commit();
  
  // Update series item count after batch commit if sermon has seriesId
  if (sermon.seriesId) {
    try {
      const { getDoc, updateDoc, increment } = await import('../../firebase/firestore');
      const seriesRef = doc(firestore, 'series', sermon.seriesId);
      const seriesDoc = await getDoc(seriesRef);
      if (seriesDoc.exists()) {
        await updateDoc(seriesRef, {
          itemCount: increment(1),
          updatedAt: new Date(),
        });
      }
    } catch (err) {
      console.error('Error updating series item count:', err);
    }
  }
  
  setUploadProgress({ error: false, message: 'Uploading...', percent: 99 });
};

const uploadFile = async (props: UploadFileProps) => {
  props.setUploadProgress({ error: false, message: 'Uploading...', percent: 0 });
  const audioSource = props.audioSource;
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

  if (audioSource.type === 'YoutubeUrl') {
    await addFirestoreDocument(
      { ...props.sermon, youtubeUrl: audioSource.source },
      props.sermonList,
      props.setUploadProgress
    );
    try {
      const generateAddIntroOutroTask = createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
      const data: AddIntroOutroInputType = {
        id: props.sermon.id,
        youtubeUrl: audioSource.source,
        startTime: props.trimStart,
        duration: props.sermon.durationSeconds,
        deleteOriginal: true,
        introUrl: introRef,
        outroUrl: outroRef,
      };
      await generateAddIntroOutroTask(data, {
        metadata: { operationKey: createOperationKey('upload-file-add-intro-outro', props.sermon.id) },
      });
      props.setUploadProgress({ error: false, percent: 100, message: 'Upload Successful!' });
    } catch (e) {
       
      console.error('Error generatingAddIntroOutroTask', e);
      props.setUploadProgress({ error: true, message: `${JSON.stringify(e)}`, percent: 0 });
      await Promise.all([deleteDoc(doc(firestore, 'sermons', props.sermon.id)), deleteObject(sermonRef)]);
    }
    // handle processing youtube video
  } else {
    await new Promise<void>((resolve, reject) => {
      uploadBytesResumable(sermonRef, audioSource.source.file, metadata).on(
        'state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 98;
          props.setUploadProgress({ error: false, percent: Math.round(progress), message: 'Uploading...' });
          switch (snapshot.state) {
            case 'paused':
              break;
            case 'running':
              break;
          }
        },
        async (error) => {
           
          console.error(error);
          props.setUploadProgress({
            error: true,
            message: `Error uploading file: ${JSON.stringify(error)}`,
            percent: 0,
          });
          await deleteDoc(doc(firestore, 'sermons', props.sermon.id));
          reject(error);
        },
        async () => {
          await addFirestoreDocument(props.sermon, props.sermonList, props.setUploadProgress);
          try {
            const generateAddIntroOutroTask = createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
            const data: AddIntroOutroInputType = {
              id: props.sermon.id,
              storageFilePath: sermonRef.fullPath,
              startTime: props.trimStart,
              duration: props.sermon.durationSeconds,
              deleteOriginal: true,
              introUrl: introRef,
              outroUrl: outroRef,
            };
            await generateAddIntroOutroTask(data, {
              metadata: { operationKey: createOperationKey('upload-file-add-intro-outro', props.sermon.id) },
            });
            props.setUploadProgress({ error: false, percent: 100, message: 'Upload Successful!' });
            resolve();
          } catch (e) {
             
            console.error('Error generatingAddIntroOutroTask', e);
            props.setUploadProgress({ error: true, message: `${JSON.stringify(e)}`, percent: 0 });
            await Promise.all([deleteDoc(doc(firestore, 'sermons', props.sermon.id)), deleteObject(sermonRef)]);
            reject(e);
          }
        }
      );
    });
  }
};
export default uploadFile;
