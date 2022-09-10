/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent, useEffect, useState } from 'react';
// import Image from 'next/image';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import styles from '../styles/SermonListCard.module.css';
// import { Sermon } from '../types/Sermon';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { formatRemainingTime } from '../utils/audioUtils';
import { PLAY_STATE, SermonWithMetadata } from '../context/types';

interface Props {
  sermon: SermonWithMetadata;
  playing: boolean;
  currentSecond: number;
  currentPlayedState: PLAY_STATE;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
  currentSecond,
  currentPlayedState,
}: // handleSermonClick,
Props) => {
  const { setCurrentSermon, togglePlaying } = useAudioPlayer();
  const [activePlayedState, setActivePlayedState] = useState(
    sermon.playedState
  );
  useEffect(() => {
    console.log(playing, currentPlayedState, sermon.playedState, currentSecond);
    if (playing) {
      setActivePlayedState({
        playPositionMilliseconds: currentSecond,
        state: currentPlayedState,
      });
    } else {
      setActivePlayedState(sermon.playedState);
    }
  }, [playing, currentPlayedState, sermon.playedState, currentSecond]);
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
              {activePlayedState.state === PLAY_STATE.COMPLETED ? (
                <>
                  <span>Played</span>
                  <span style={{ color: 'lightgreen' }}> &#10003;</span>
                </>
              ) : (
                <>
                  <span className={styles.timeLeft}>
                    {formatRemainingTime(
                      Math.floor(sermon.durationSeconds) -
                        activePlayedState.playPositionMilliseconds
                    ) +
                      (activePlayedState.state === PLAY_STATE.IN_PROGRESS
                        ? ' left'
                        : '')}
                  </span>
                </>
              )}
            </div>
            {activePlayedState.state === PLAY_STATE.IN_PROGRESS && (
              <progress
                className={styles.songProgress}
                value={activePlayedState.playPositionMilliseconds}
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
