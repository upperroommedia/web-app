/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent } from 'react';
// import Image from 'next/image';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import styles from '../styles/SermonListCard.module.css';
// import { Sermon } from '../types/Sermon';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';

interface Props {
  sermon: SermonWithMetadata;
  playing: boolean;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
}: // handleSermonClick,
Props) => {
  const { setCurrentSermon, togglePlaying } = useAudioPlayer();
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
          </div>
        </div>
      </div>
    </div>
  );
};
export default SermonListCard;
