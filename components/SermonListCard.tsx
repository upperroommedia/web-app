/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent } from 'react';
// import Image from 'next/image';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import styles from '../styles/SermonListCard.module.css';
import { Sermon } from '../types/Sermon';

interface Props {
  sermon: Sermon;
  handleSermonClick: (sermon: Sermon) => void;
  playSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  handleSermonClick,
  playSermonClick,
}: Props) => {
  const date = new Date(sermon.date as unknown as string);
  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        handleSermonClick(sermon);
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
                playSermonClick(sermon);
              }}
            >
              <PlayCircleIcon />
            </IconButton>
            <h2 className={styles.date}>{date.toDateString()}</h2>
          </div>
        </div>
      </div>
    </div>
  );
};
export default SermonListCard;
