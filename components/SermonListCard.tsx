/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent, useEffect, useState } from 'react';
// import Image from 'next/image';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import styles from '../styles/SermonListCard.module.css';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';
import firestore, { arrayRemove, deleteDoc, deleteField, doc, updateDoc } from '../firebase/firestore';
import storage, { deleteObject, getDownloadURL, ref } from '../firebase/storage';
import { emptySermon, sermonConverter } from '../types/Sermon';
import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';
import PopUp from './PopUp';
import EditSermonForm from './EditSermonForm';
import useAuth from '../context/user/UserContext';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../functions/src/uploadToSoundCloud';
import { createFunction, createFunctionV2 } from '../utils/createFunction';
import PublishIcon from '@mui/icons-material/Publish';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import Image from 'next/image';
import Logo from '../public/upper_room_media_icon.png';
import SoundCloudLogo from '../public/soundcloud.png';
import { sanitize } from 'dompurify';
import DeleteEntityPopup from './DeleteEntityPopup';
import { seriesConverter } from '../types/Series';
import { Tooltip } from '@mui/material';

interface Props {
  sermon: SermonWithMetadata;
  playing: boolean;
  playlist: Sermon[];
  setPlaylist: (playlist: Sermon[]) => void;
  minimal?: boolean;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
  playlist,
  setPlaylist,
  minimal,
}: // handleSermonClick,
Props) => {
  const { user } = useAuth();
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);
  const [uploadToSupsplashPopup, setUploadToSupsplashPopup] = useState<boolean>(false);

  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [updatedSermon, setUpdatedSermon] = useState<Sermon>(emptySermon);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isUploadingToSoundCloud, setIsUploadingToSoundCloud] = useState<boolean>(false);

  useEffect(() => {
    if (updatedSermon !== emptySermon) {
      const index = playlist.findIndex((object) => {
        return object.key === sermon.key;
      });
      const newPlaylist = [...playlist];
      newPlaylist[index] = updatedSermon;
      setPlaylist(newPlaylist);
    }
  }, [updatedSermon]);

  const { setCurrentSermon, togglePlaying } = useAudioPlayer();
  const handleDelete = async () => {
    try {
      if (sermon.subsplashId) {
        await Promise.allSettled([deleteFromSubsplash(), deleteFromSoundCloud()]);
      }
      const firebasePromises = [
        deleteObject(ref(storage, `sermons/${sermon.key}`)),
        deleteDoc(doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter)),
      ];

      if (sermon.series?.name !== undefined) {
        const seriesRef = doc(firestore, 'series', sermon.series.id).withConverter(seriesConverter);
        firebasePromises.push(updateDoc(seriesRef, { sermonIds: arrayRemove(sermon.key) }));
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
      description: sermon.subtitle,
      tags: sermon.topics,
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
    if (sermon.soundCloudTrackId === undefined) {
      return;
    }
    setIsUploadingToSoundCloud(true);
    const deleteFromSoundCloud = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
    try {
      await deleteFromSoundCloud({ soundCloudTrackId: sermon.soundCloudTrackId });
      const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
      await updateDoc(sermonRef, {
        soundCloudTrackId: deleteField(),
        status: { ...sermon.status, soundCloud: uploadStatus.NOT_UPLOADED },
      });
    } catch (error) {
      alert(error);
    }
    setIsUploadingToSoundCloud(false);
  };

  const uploadToSubsplash = async () => {
    const uploadToSubsplash = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>('uploadToSubsplash');
    const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.key}`));
    const data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
      title: sermon.title,
      subtitle: sermon.subtitle,
      speakers: sermon.speakers,
      autoPublish: autoPublish,
      audioTitle: sermon.title,
      audioUrl: url,
      topics: sermon.topics,
      description: sermon.description,
      images: sermon.images,
      date: new Date(sermon.dateMillis),
    };
    setIsUploading(true);
    try {
      // TODO [1]: Fix return Type
      const response = (await uploadToSubsplash(data)) as unknown as { id: string };
      const id = response.id;
      const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
      await updateDoc(sermonRef, { subsplashId: id, status: { ...sermon.status, subsplash: uploadStatus.UPLOADED } });
    } catch (error) {
      alert(error);
    }
    setIsUploading(false);
    setUploadToSupsplashPopup(false);
  };

  const deleteFromSubsplash = async () => {
    const deleteFromSubsplashCall = createFunction<string, void>('deleteFromSubsplash');
    try {
      setIsUploading(true);
      await deleteFromSubsplashCall(sermon.subsplashId!);
      await updateDoc(doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter), {
        subsplashId: deleteField(),
        status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
      });
      setIsUploading(false);
    } catch (error: any) {
      if (error.code === 'functions/not-found') {
        await updateDoc(doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter), {
          subsplashId: deleteField(),
          status: { ...sermon.status, subsplash: uploadStatus.NOT_UPLOADED },
        });
        setIsUploading(false);
      } else {
        setIsUploading(false);
        alert(error);
      }
    }
  };

  const AdminControls: FunctionComponent = () => {
    if (window.location.pathname !== '/admin' || user?.role !== 'admin') {
      return null;
    }
    return (
      <div>
        {isUploadingToSoundCloud ? (
          <CircularProgress size={24} />
        ) : sermon.status.soundCloud === uploadStatus.UPLOADED ? (
          <Tooltip title="Remove From Soundcloud">
            <IconButton aria-label="Upload to Subsplash" onClick={deleteFromSoundCloud}>
              <UnpublishedIcon style={{ color: 'orangered' }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Upload to Soundcloud">
            <IconButton onClick={() => uploadToSoundCloud()}>
              <Image src={SoundCloudLogo} width={24} height={24} />
            </IconButton>
          </Tooltip>
        )}
        {isUploading ? (
          <CircularProgress size={24} />
        ) : sermon.status.subsplash === uploadStatus.UPLOADED ? (
          <Tooltip title="Remove From Subsplash">
            <IconButton aria-label="Upload to Subsplash" onClick={deleteFromSubsplash}>
              <UnpublishedIcon style={{ color: 'orangered' }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Upload to Subsplash">
            <IconButton
              aria-label="Upload to Subsplash"
              style={{ color: 'lightgreen' }}
              onClick={() => {
                setUploadToSupsplashPopup(true);
              }}
            >
              <PublishIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Edit Sermon">
          <IconButton aria-label="edit sermon" style={{ color: 'lightblue' }} onClick={() => setEditFormPopup(true)}>
            <EditIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete Sermon From All Systems">
          <IconButton
            aria-label="delete sermon"
            style={{ color: 'red' }}
            onClick={() => setDeleteConfirmationPopup(true)}
          >
            <DeleteIcon />
          </IconButton>
        </Tooltip>
      </div>
    );
  };

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        // handleSermonClick(sermon);
      }}
      className={styles.cardContainer}
    >
      <hr className={styles['horizontal-line']}></hr>
      <div className={styles.cardContent}>
        <div className={styles.divImage}>
          <Image
            src={
              sermon.images?.find((image) => image.type === 'square')
                ? sanitize(sermon.images.find((image) => image.type === 'square')!.downloadLink)
                : Logo
            }
            layout="fill"
          />
        </div>
        <div className={styles.divText}>
          <h1 className={styles.title}>{`${sermon.title}: ${sermon.subtitle}`}</h1>
          <p className={styles.description}>{sermon.description}</p>
          <div className={styles.bottomDiv}>
            {!minimal && (
              <>
                <IconButton
                  aria-label="toggle play/pause"
                  onClick={(e) => {
                    e.preventDefault();
                    setCurrentSermon(sermon);
                    togglePlaying(!playing);
                    // TODO(1): Handle CLICK EVENT
                  }}
                >
                  {playing ? <PauseCircleIcon /> : <PlayCircleIcon />}
                </IconButton>
                <div className={styles.bottomDivText}>
                  <span className={styles.date}>{sermon.dateString}</span>
                  <span>·</span>
                  {sermon.currentSecond < Math.floor(sermon.durationSeconds) ? (
                    <>
                      <span className={styles.timeLeft}>
                        {formatRemainingTime(Math.floor(sermon.durationSeconds) - sermon.currentSecond) +
                          (playing || sermon.currentSecond > 0 ? ' left' : '')}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>Played</span>
                      <span style={{ color: 'lightgreen' }}> &#10003;</span>
                    </>
                  )}
                </div>
              </>
            )}
            {sermon.currentSecond < Math.floor(sermon.durationSeconds) && (playing || sermon.currentSecond > 0) && (
              <progress
                className={styles.songProgress}
                value={sermon.currentSecond}
                max={Math.floor(sermon.durationSeconds)}
              />
            )}
            <span style={{ width: '60%' }}></span>
            {sermon.status.audioStatus === sermonStatusType.PROCESSED ? (
              <AdminControls />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                  <h3 style={{ margin: 0 }}>{sermon.status.audioStatus}</h3>
                  {sermon.status.audioStatus === sermonStatusType.PROCESSING && <CircularProgress size={15} />}
                </div>
                {sermon.status.message && <p style={{ margin: 0 }}>{sermon.status.message}</p>}
              </div>
            )}
            <PopUp
              title={'Upload Sermon to Supsplash?'}
              open={uploadToSupsplashPopup}
              setOpen={() => setUploadToSupsplashPopup(false)}
              button={
                <Button aria-label="Confirm Upload to Subsplash" onClick={uploadToSubsplash}>
                  {isUploading ? <CircularProgress /> : 'Upload'}
                </Button>
              }
            >
              <div>
                <span>Title: {sermon.title}</span>
                <div style={{ display: 'flex' }} onClick={() => setAutoPublish((previousValue) => !previousValue)}>
                  <Checkbox checked={autoPublish} />
                  <p>Auto publish when upload is complete</p>
                </div>
              </div>
            </PopUp>
            <DeleteEntityPopup
              entityBeingDeleten="sermon"
              handleDelete={handleDelete}
              deleteConfirmationPopup={deleteConfirmationPopup}
              setDeleteConfirmationPopup={setDeleteConfirmationPopup}
            />
            <EditSermonForm
              open={editFormPopup}
              setOpen={() => setEditFormPopup(false)}
              sermon={sermon}
              setUpdatedSermon={setUpdatedSermon}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
export default SermonListCard;
