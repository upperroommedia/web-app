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
import { Button, Checkbox, CircularProgress } from '@mui/material';
// import { Sermon } from '../types/Sermon';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';
import firestore, { deleteDoc, deleteField, doc, setDoc, updateDoc } from '../firebase/firestore';
import storage, { deleteObject, getDownloadURL, ref } from '../firebase/storage';
import { emptySermon, Sermon } from '../types/Sermon';
import PopUp from './PopUp';
import EditSermonForm from './EditSermonForm';
import useAuth from '../context/user/UserContext';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../functions/src/uploadToSubsplash';
import { createFunction } from '../utils/createFunction';

interface Props {
  sermon: SermonWithMetadata;
  playing: boolean;
  playlist: Sermon[];
  setPlaylist: (playlist: Sermon[]) => void;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
  playlist,
  setPlaylist,
}: // handleSermonClick,
Props) => {
  const { user } = useAuth();
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);
  const [uploadToSupsplashPopup, setUploadToSupsplashPopup] = useState<boolean>(false);

  const [updatedSermon, setUpdatedSermon] = useState<Sermon>(emptySermon);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [deleteChecked, setDeleteChecked] = useState<boolean>(false);
  const [autoPublish, setAutoPublish] = useState<boolean>(false);

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

  const handleDelete = async (id: string) => {
    try {
      await deleteObject(ref(storage, `sermons/${id}`));
      await deleteDoc(doc(firestore, 'sermons', id));
      setPlaylist(playlist.filter((obj) => obj.key !== sermon.key));
    } catch (error) {
      alert(error);
    }
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
        <div className={styles.divImage}></div>
        <div className={styles.divText}>
          <h1 className={styles.title}>{`${sermon.title}: ${sermon.subtitle}`}</h1>
          <p className={styles.description}>{sermon.description}</p>
          <div className={styles.bottomDiv}>
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
            {sermon.currentSecond < Math.floor(sermon.durationSeconds) && (playing || sermon.currentSecond > 0) && (
              <progress
                className={styles.songProgress}
                value={sermon.currentSecond}
                max={Math.floor(sermon.durationSeconds)}
              />
            )}
            <span style={{ width: '100%' }}></span>
            {user?.role === 'admin' ? (
              <>
                {sermon.subsplashId ? (
                  <Button
                    aria-label="Upload to Subsplash"
                    onClick={async () => {
                      console.log(`Deleting sermon ${sermon.title} from subsplash: ${sermon.subsplashId}`);
                      const deleteFromSubsplash = createFunction<string, void>('deleteFromSubsplash');
                      try {
                        setIsUploading(true);
                        console.log(await deleteFromSubsplash(sermon.subsplashId!));
                        await updateDoc(doc(firestore, 'sermons', sermon.key), {
                          subsplashId: deleteField(),
                        });
                        sermon.subsplashId = undefined;
                        setIsUploading(false);
                      } catch (error) {
                        if (error.code === 'functions/not-found') {
                          await updateDoc(doc(firestore, 'sermons', sermon.key), {
                            subsplashId: deleteField(),
                          });
                          sermon.subsplashId = undefined;
                          setIsUploading(false);
                        } else {
                          setIsUploading(false);
                          alert(error);
                        }
                      }
                      // TODO[0]: Replace this with a listener on the firestore database
                    }}
                  >
                    {isUploading ? <CircularProgress size={24} /> : <span>Delete From Subsplash</span>}
                  </Button>
                ) : (
                  <Button
                    aria-label="Upload to Subsplash"
                    onClick={() => {
                      setUploadToSupsplashPopup(true);
                    }}
                  >
                    Upload To Subsplash
                  </Button>
                )}
                <IconButton
                  aria-label="edit sermon"
                  style={{ color: 'lightblue' }}
                  onClick={() => setEditFormPopup(true)}
                >
                  <EditIcon />
                </IconButton>
                <IconButton
                  aria-label="delete sermon"
                  style={{ color: 'red' }}
                  onClick={() => setDeleteConfirmationPopup(true)}
                >
                  <DeleteIcon />
                </IconButton>
              </>
            ) : (
              <></>
            )}
            <PopUp
              title={'Upload Sermon to Supsplash?'}
              open={uploadToSupsplashPopup}
              setOpen={() => setUploadToSupsplashPopup(false)}
              button={
                <Button
                  aria-label="Confirm Upload to Subsplash"
                  onClick={async () => {
                    const uploadToSubsplash = createFunction<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, void>(
                      'uploadToSubsplash'
                    );
                    const url = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.key}`));
                    console.log(url);
                    const data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
                      title: sermon.title,
                      subtitle: sermon.subtitle,
                      speakers: sermon.speaker,
                      autoPublish: false,
                      audioTitle: sermon.title,
                      audioUrl: url,
                      topics: sermon.topic,
                      description: sermon.description,
                    };
                    setIsUploading(true);
                    try {
                      const response = await uploadToSubsplash(data);
                      console.log(response);
                      const id = response.id;
                      const sermonRef = doc(firestore, 'sermons', sermon.key);
                      await setDoc(sermonRef, { subsplashId: id }, { merge: true });
                      sermon.subsplashId = id;
                    } catch (error) {
                      alert(error);
                    }
                    setIsUploading(false);
                    setUploadToSupsplashPopup(false);
                  }}
                >
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
            <PopUp
              title={'Are you sure you want to permanently delete this sermon?'}
              open={deleteConfirmationPopup}
              setOpen={() => setDeleteConfirmationPopup(false)}
              button={
                <Button
                  aria-label="confirm delete sermon"
                  variant="contained"
                  onClick={() => {
                    handleDelete(sermon.key).then(() => {
                      setDeleteConfirmationPopup(false);
                      setDeleteChecked(false);
                    });
                  }}
                  color="primary"
                  disabled={!deleteChecked}
                >
                  Delete Forever
                </Button>
              }
            >
              <div>
                <div style={{ display: 'flex' }} onClick={() => setDeleteChecked((previousValue) => !previousValue)}>
                  <Checkbox checked={deleteChecked} />
                  <p>I understand that deleting is permanent and cannot be undone</p>
                </div>
              </div>
            </PopUp>
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
