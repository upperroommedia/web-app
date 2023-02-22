/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent } from 'react';
import { sanitize } from 'dompurify';
import Image from 'next/image';

import styles from '../styles/SermonListCard.module.css';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import CircularProgress from '@mui/material/CircularProgress';
import ListItem from '@mui/material/ListItem';
import Divider from '@mui/material/Divider';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';

import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';

import { Sermon, sermonStatusType } from '../types/SermonTypes';

import Logo from '../public/URM_icon.png';
import AdminControls from './SermonCardAdminControls';

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
  const { setCurrentSermon, togglePlaying } = useAudioPlayer();

  return (
    <>
      <Divider />
      <ListItem
      // onClick={(e) => {
      //   e.preventDefault();
      //   // handleSermonClick(sermon);
      // }}
      >
        <Card sx={{ width: 1, display: 'flex', gap: 3, padding: 2 }} elevation={0}>
          <Image
            src={
              sermon.images?.find((image) => image.type === 'square')
                ? sanitize(sermon.images.find((image) => image.type === 'square')!.downloadLink)
                : Logo
            }
            alt={`Image for ${sermon.title}`}
            width={150}
            height={150}
            style={{ borderRadius: '5px' }}
          />
          <Box display={'flex'} flexDirection="column" justifyContent="space-between" width={1}>
            <Typography variant="h5">
              <Box sx={{ fontWeight: 'bold' }}>{`${sermon.title}: ${sermon.subtitle}`}</Box>
            </Typography>
            <Typography variant="subtitle1" className={styles.description}>
              {sermon.description}
            </Typography>
            <Box display={'flex'} marginLeft={3} alignItems={'center'}>
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
                    {playing ? <PauseCircleIcon fontSize="large" /> : <PlayCircleIcon fontSize="large" />}
                  </IconButton>
                  <Box display="flex" gap={1} marginRight={3}>
                    <Typography style={{ whiteSpace: 'nowrap' }}>{sermon.dateString}</Typography>
                    <Typography>·</Typography>
                    {sermon.currentSecond < Math.floor(sermon.durationSeconds) ? (
                      <>
                        <Typography style={{ whiteSpace: 'nowrap' }}>
                          {formatRemainingTime(Math.floor(sermon.durationSeconds) - sermon.currentSecond) +
                            (playing || sermon.currentSecond > 0 ? ' left' : '')}
                        </Typography>
                      </>
                    ) : (
                      <>
                        <Typography>Played</Typography>
                        <Typography style={{ color: 'lightgreen' }}> &#10003;</Typography>
                      </>
                    )}
                  </Box>
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
                <AdminControls sermon={sermon} playlist={playlist} setPlaylist={setPlaylist} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <h3 style={{ margin: 0 }}>{sermon.status.audioStatus}</h3>
                    {sermon.status.audioStatus === sermonStatusType.PROCESSING && <CircularProgress size={15} />}
                  </div>
                  {sermon.status.message && <p style={{ margin: 0 }}>{sermon.status.message}</p>}
                </div>
              )}
            </Box>
          </Box>
        </Card>
      </ListItem>
    </>
  );
};
export default SermonListCard;
