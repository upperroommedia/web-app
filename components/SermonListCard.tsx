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
import { Button, Checkbox } from '@mui/material';
// import { Sermon } from '../types/Sermon';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';
import { deleteDoc, doc, getFirestore } from 'firebase/firestore';

import { emptySermon, Sermon } from '../types/Sermon';
import { firebase } from '../firebase/firebase';
import PopUp from './PopUp';
import EditSermonForm from './EditSermonForm';

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
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] =
    useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);

  const [updatedSermon, setUpdatedSermon] = useState<Sermon>(emptySermon);

  const [deleteChecked, setDeleteChecked] = useState<boolean>(false);

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
  const db = getFirestore(firebase);

  const handleDelete = async (id: string) => {
    await deleteDoc(doc(db, 'sermons', id)).then(() =>
      setPlaylist(playlist.filter((obj) => obj.key !== sermon.key))
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
        <div className={styles.divImage}></div>
        <div className={styles.divText}>
          <h1
            className={styles.title}
          >{`${sermon.title}: ${sermon.subtitle}`}</h1>
          <p className={styles.description}>{sermon.description}</p>
          <div className={styles.bottomDiv}>
            <IconButton
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
                    {formatRemainingTime(
                      Math.floor(sermon.durationSeconds) - sermon.currentSecond
                    ) + (playing || sermon.currentSecond > 0 ? ' left' : '')}
                  </span>
                </>
              ) : (
                <>
                  <span>Played</span>
                  <span style={{ color: 'lightgreen' }}> &#10003;</span>
                </>
              )}
            </div>
            {sermon.currentSecond < Math.floor(sermon.durationSeconds) &&
              (playing || sermon.currentSecond > 0) && (
                <progress
                  className={styles.songProgress}
                  value={sermon.currentSecond}
                  max={Math.floor(sermon.durationSeconds)}
                />
              )}
            <span style={{ width: '100%' }}></span>
            <IconButton
              style={{ color: 'lightblue' }}
              onClick={() => setEditFormPopup(true)}
            >
              <EditIcon />
            </IconButton>
            <IconButton
              style={{ color: 'red' }}
              onClick={() => setDeleteConfirmationPopup(true)}
            >
              <DeleteIcon />
            </IconButton>
            <PopUp
              title={'Are you sure you want to permanently delete this sermon?'}
              open={deleteConfirmationPopup}
              setOpen={() => setDeleteConfirmationPopup(false)}
              button={
                <Button
                  variant="contained"
                  onClick={() => {
                    handleDelete(sermon.key).then(() =>
                      setDeleteConfirmationPopup(false)
                    );
                  }}
                  color="primary"
                  disabled={!deleteChecked}
                >
                  Delete Forever
                </Button>
              }
            >
              <div>
                <div style={{ display: 'flex' }}>
                  <Checkbox
                    checked={deleteChecked}
                    onClick={() => setDeleteChecked(!deleteChecked)}
                  />
                  <p>
                    I understand that deleting is permanent and cannot be undone
                  </p>
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
