import { FunctionComponent, useState } from 'react';

import storage, { deleteObject, getDownloadURL, ref } from '../firebase/storage';
import firestore, {
  arrayRemove,
  deleteDoc,
  deleteField,
  doc,
  DocumentReference,
  runTransaction,
  updateDoc,
} from '../firebase/firestore';

import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { AddToSeriesInputType } from '../functions/src/addToSeries';
import { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../functions/src/uploadToSoundCloud';
import { createFunction, createFunctionV2 } from '../utils/createFunction';

import { Series, seriesConverter } from '../types/Series';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import { sermonConverter } from '../types/Sermon';

import useAuth from '../context/user/UserContext';
import SermonCardAdminControlsComponent from './SermonCardAdminControlsComponent';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../functions/src/createNewSubsplashList';

export interface AdminControlsProps {
  sermon: Sermon;
  playlist: Sermon[];
  setPlaylist: (playlist: Sermon[]) => void;
}

const AdminControls: FunctionComponent<AdminControlsProps> = ({
  sermon,
  playlist,
  setPlaylist,
}: AdminControlsProps) => {
  const [isUploadingToSubsplash, setIsUploadingToSubsplash] = useState<boolean>(false);
  const { user } = useAuth();

  const [uploadToSubsplashPopup, setUploadToSubsplashPopup] = useState<boolean>(false);
  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState<boolean>(false);

  const handleDelete = async () => {
    try {
      const promises: Promise<any>[] = [];
      if (sermon.subsplashId) {
        promises.push(deleteFromSubsplash(true));
      }
      if (sermon.soundCloudTrackId) {
        promises.push(deleteFromSoundCloudErrorThrowable());
      }
      const results = await Promise.allSettled(promises);

      let successful = true;
      results.forEach((result) => {
        if (result.status === 'rejected') {
          alert(result.reason);
          successful = false;
        }
      });

      if (!successful) {
        return;
      }

      const firebasePromises = [
        deleteObject(ref(storage, `sermons/${sermon.key}`)),
        deleteDoc(doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter)),
      ];

      if (sermon.series.length !== 0) {
        sermon.series.forEach(async (series) => {
          const seriesRef = doc(firestore, 'series', series.id).withConverter(seriesConverter);
          await updateDoc(seriesRef, { allSermons: arrayRemove(sermon), sermonsInSubsplash: arrayRemove(sermon) });
        });
      }
      await Promise.allSettled(firebasePromises);
      setPlaylist(playlist.filter((obj) => obj.key !== sermon.key));
    } catch (error) {
      alert(error);
    }
  };

  const uploadToSoundCloud = async () => {
    setIsUploadingToSoundCloud(true);
    const uploadToSoundCloud = createFunctionV2<UploadToSoundCloudInputType, UploadToSoundCloudReturnType>(
      'uploadtosoundcloud'
    );
    const data: UploadToSoundCloudInputType = {
      title: sermon.title,
      description: sermon.description,
      tags: [sermon.subtitle, ...sermon.topics],
      speakers: sermon.speakers.map((speaker) => speaker.name),
      audioUrl: await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.key}`)),
      imageUrl: sermon.images.find((image) => image.type === 'square')?.downloadLink,
    };
    try {
      const result = await uploadToSoundCloud(data);
      const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
      await updateDoc(sermonRef, {
        soundCloudTrackId: result.soundCloudTrackId,
        status: { ...sermon.status, soundCloud: uploadStatus.UPLOADED },
      });
    } catch (error) {
      alert(error);
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  };

  const deleteFromSoundCloud = async () => {
    try {
      await deleteFromSoundCloudErrorThrowable();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      // TODO: handle error
      alert(error);
    }
  };

  const deleteFromSoundCloudErrorThrowable = async () => {
    if (sermon.soundCloudTrackId === undefined) {
      return;
    }
    setIsUploadingToSoundCloud(true);
    const deleteFromSoundCloud = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
    const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
    try {
      await deleteFromSoundCloud({ soundCloudTrackId: sermon.soundCloudTrackId });
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
    } catch (error) {
      type httpError = {
        code: string;
        name: string;
        details?: string;
      };
      const { details }: httpError = JSON.parse(JSON.stringify(error));
      if (details?.includes('Invalid track id')) {
        await updateDoc(sermonRef, {
          soundCloudTrackId: deleteField(),
          status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
        });
      }
    } finally {
      setIsUploadingToSoundCloud(false);
    }
  };

  const uploadToSubsplash = async () => {
    const uploadToSubsplash = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
    const addToSeries = createFunctionV2<AddToSeriesInputType, void>('addtoseries');
    const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.key}`));
    const data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
      title: sermon.title,
      subtitle: sermon.subtitle,
      speakers: sermon.speakers,
      autoPublish,
      audioTitle: sermon.title,
      audioUrl: url,
      topics: sermon.topics,
      description: sermon.description,
      images: sermon.images,
      date: new Date(sermon.dateMillis),
    };
    setIsUploadingToSubsplash(true);
    try {
      // TODO [1]: Fix return Type
      const response = (await uploadToSubsplash(data)) as unknown as { id: string };
      const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
      const id = response.id;
      await updateDoc(sermonRef, { subsplashId: id });
      const seriesMetadata = await Promise.all(
        sermon.series.map(async (s) => {
          if (s.subsplashId) {
            return { listId: s.subsplashId, overflowBehavior: s.overflowBehavior };
          }
          // upload series to subsplash
          const createNewSubsplashList = createFunctionV2<
            CreateNewSubsplashListInputType,
            CreateNewSubsplashListOutputType
          >('createnewsubsplashlist');
          const { listId } = await createNewSubsplashList({ title: s.name, subtitle: '', images: s.images });
          const seriesRef = doc(firestore, 'series', s.id).withConverter(seriesConverter);
          await updateDoc(seriesRef, { subsplashId: listId });
          return { listId, overflowBehavior: s.overflowBehavior };
        })
      );

      // TODO: handle overflow behavior properly
      await addToSeries({
        seriesMetadata,
        mediaItemIds: [{ id, type: 'media-item' }],
      });
      await updateDoc(sermonRef, { status: { ...sermon.status, subsplash: uploadStatus.UPLOADED } });
    } catch (error) {
      alert(error);
    }
    setIsUploadingToSubsplash(false);
    setUploadToSubsplashPopup(false);
  };

  const deleteFromSubsplash = async (deleteCompletely?: true) => {
    try {
      await deleteFromSubsplashErrorThrowable(deleteCompletely);
    } catch (error) {
      // TODO: handle error
      alert(error);
    }
  };

  const handleFirestoreDeleteFromSubsplash = async (deleteCompletely?: true) => {
    await runTransaction(firestore, async (transaction) => {
      const fireStoreSeries: { seriesRef: DocumentReference; series: Series }[] = await Promise.all(
        sermon.series.map(async (s) => {
          const seriesRef = doc(firestore, 'series', s.id).withConverter(seriesConverter);
          const series = (await transaction.get(seriesRef)).data();
          if (series) {
            return { seriesRef, series };
          }
          throw new Error('Series not found');
        })
      );
      transaction.update(doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter), {
        subsplashId: deleteField(),
        status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
      });
      fireStoreSeries.map(async ({ seriesRef, series }) => {
        transaction.update(seriesRef, {
          sermonsInSubsplash: series.sermonsInSubsplash.filter((s) => s.key !== sermon.key),
          ...(deleteCompletely === true && { allSermons: series.allSermons.filter((s) => s.key !== sermon.key) }),
        });
      });
    });
  };

  const deleteFromSubsplashErrorThrowable = async (deleteCompletely?: true) => {
    const deleteFromSubsplashCall = createFunction<string, void>('deleteFromSubsplash');
    try {
      setIsUploadingToSubsplash(true);
      await deleteFromSubsplashCall(sermon.subsplashId!);
      await handleFirestoreDeleteFromSubsplash(deleteCompletely);
      setIsUploadingToSubsplash(false);
    } catch (error: any) {
      if (error.code === 'functions/not-found') {
        await handleFirestoreDeleteFromSubsplash(deleteCompletely);
      } else {
        throw error;
      }
    } finally {
      setIsUploadingToSubsplash(false);
    }
  };
  if (window.location.pathname !== '/admin/sermons' || user?.role !== 'admin') {
    return null;
  }
  return (
    <SermonCardAdminControlsComponent
      sermon={sermon}
      isUploadingToSoundCloud={isUploadingToSoundCloud}
      isUploadingToSubsplash={isUploadingToSubsplash}
      uploadToSubsplashPopup={uploadToSubsplashPopup}
      autoPublish={autoPublish}
      setUploadToSubsplashPopup={setUploadToSubsplashPopup}
      setAutoPublish={setAutoPublish}
      handleDelete={handleDelete}
      uploadToSoundCloud={uploadToSoundCloud}
      uploadToSubsplash={uploadToSubsplash}
      deleteFromSoundCloud={deleteFromSoundCloud}
      deleteFromSubsplash={deleteFromSubsplash}
    />
  );
};

export default AdminControls;
