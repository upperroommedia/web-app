import { FunctionComponent, useState } from 'react';

import firestore, {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  updateDoc,
  writeBatch,
} from '../firebase/firestore';

import { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../functions/src/uploadToSoundCloud';
import { createFunction, createFunctionV2 } from '../utils/createFunction';

import { Sermon, uploadStatus } from '../types/SermonTypes';
import { sermonConverter } from '../types/Sermon';

import useAuth from '../context/user/UserContext';
import SermonCardAdminControlsComponent from './SermonCardAdminControlsComponent';
import { getSquareImageStoragePath } from '../utils/utils';
import { sermonListConverter } from '../types/SermonList';
import useAudioPlayer from '../context/audio/audioPlayerContext';

export interface AdminControlsProps {
  sermon: Sermon;
}

const AdminControls: FunctionComponent<AdminControlsProps> = ({ sermon }: AdminControlsProps) => {
  const { user } = useAuth();
  const { currentSermon, setCurrentSermon } = useAudioPlayer();
  const [isUploadingToSubsplash, setIsUploadingToSubsplash] = useState<boolean>(false);
  const [uploadToSubsplashPopup, setUploadToSubsplashPopup] = useState<boolean>(false);
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState<boolean>(false);

  const handleDelete = async () => {
    try {
      const promises: Promise<any>[] = [];
      if (sermon.subsplashId) {
        promises.push(deleteFromSubsplash());
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
      await deleteDoc(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter));
      if (currentSermon?.id === sermon.id) {
        setCurrentSermon(undefined);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
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
      audioStoragePath: `intro-outro-sermons/${sermon.id}`,
      imageStoragePath: getSquareImageStoragePath(sermon),
    };
    try {
      const result = await uploadToSoundCloud(data);
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
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
    const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
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

  const deleteFromSubsplash = async () => {
    try {
      await deleteFromSubsplashErrorThrowable();
    } catch (error) {
      // TODO: handle error
      alert(error);
    }
  };

  const handleFirestoreDeleteFromSubsplash = async () => {
    const batch = writeBatch(firestore);
    const sermonSeriesList = collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(
      sermonListConverter
    );
    const sermonSeriesListSnapshot = await getDocs(sermonSeriesList);
    sermonSeriesListSnapshot.forEach((doc) => {
      batch.update(doc.ref, {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      });
    });
    batch.update(doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter), {
      subsplashId: deleteField(),
      status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
    });
    await batch.commit();
  };

  const deleteFromSubsplashErrorThrowable = async () => {
    const deleteFromSubsplashCall = createFunction<string, void>('deleteFromSubsplash');
    try {
      setIsUploadingToSubsplash(true);
      await deleteFromSubsplashCall(sermon.subsplashId!);
      await handleFirestoreDeleteFromSubsplash();
      setIsUploadingToSubsplash(false);
    } catch (error: any) {
      if (error.code === 'functions/not-found') {
        await handleFirestoreDeleteFromSubsplash();
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
      manageUploadsPopup={uploadToSubsplashPopup}
      setManageUploadsPopup={setUploadToSubsplashPopup}
      setIsUploadingToSubsplash={setIsUploadingToSubsplash}
      handleDelete={handleDelete}
      uploadToSoundCloud={uploadToSoundCloud}
      deleteFromSoundCloud={deleteFromSoundCloud}
      deleteFromSubsplash={deleteFromSubsplash}
    />
  );
};

export default AdminControls;
