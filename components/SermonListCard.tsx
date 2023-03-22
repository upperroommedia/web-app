/**
 * SermonListCard: A component to display sermons in a list
 */
import { FunctionComponent } from 'react';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import ListItem from '@mui/material/ListItem';
import Divider from '@mui/material/Divider';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';

import useAudioPlayer from '../context/audio/audioPlayerContext';
import { SermonWithMetadata } from '../reducers/audioPlayerReducer';
import { formatRemainingTime } from '../utils/audioUtils';

import { Sermon, sermonStatusType } from '../types/SermonTypes';

import AdminControls from './SermonCardAdminControls';
import LinearProgress from '@mui/material/LinearProgress';
import CardActions from '@mui/material/CardActions';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import useMediaQuery from '@mui/material/useMediaQuery';
import useTheme from '@mui/system/useTheme';
import { ErrorBoundary } from 'react-error-boundary';

import { useObject } from 'react-firebase-hooks/database';
import database, { ref } from '../firebase/database';
import CircularProgressWithLabel from './CircularProgressWithLabel';

interface Props {
  sermon: SermonWithMetadata;
  playing: boolean;
  playlist: Sermon[];
  setPlaylist: (playlist: Sermon[]) => void;
  minimal?: boolean;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({ sermon, playing, playlist, setPlaylist, minimal }: Props) => {
  const { setCurrentSermon, togglePlaying } = useAudioPlayer();
  const theme = useTheme();
  const mdMatches = useMediaQuery(theme.breakpoints.up('md'));
  const smMatches = useMediaQuery(theme.breakpoints.up('sm'));
  const [snapshot, _loading, _error] = useObject(ref(database, `addIntroOutro/${sermon.key}`));
  return (
    <ErrorBoundary fallback={<Box>Error Loading Card</Box>}>
      <Divider />
      <ListItem
      // onClick={(e) => {
      //   e.preventDefault();
      //   // handleSermonClick(sermon);
      // }}
      >
        <Card
          sx={{
            width: 1,
            display: 'grid',
            gridTemplateAreas: {
              xs: `"image title title"
                   "description description description"
                   "playStatus playStatus playStatus"
                   "actionItems actionItems playPause"`,
              sm: `"image title title title"
                   "image description description description"
                   "image playPause playStatus actionItems "`,
            },
            gridTemplateColumns: { xs: 'min-content auto min-content', sm: 'min-content min-content auto min-content' },
            gridColumnGap: '10px',
            padding: 0,
          }}
          elevation={0}
        >
          <AvatarWithDefaultImage
            sx={{ gridArea: 'image' }}
            width={mdMatches ? 150 : smMatches ? 100 : 50}
            height={mdMatches ? 150 : smMatches ? 100 : 50}
            altName={sermon.title}
            borderRadius={5}
            image={sermon.images?.find((image) => image.type === 'square')}
          />
          <Box display="flex" alignItems="center" sx={{ gridArea: 'title' }}>
            <Typography variant="h5">
              <Box sx={{ fontWeight: 'bold' }}>{`${sermon.title}: ${sermon.subtitle}`}</Box>
            </Typography>
          </Box>
          <Typography
            sx={{
              gridArea: 'description',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2 /* number of lines to show */,
              WebkitBoxOrient: 'vertical',
              marginTop: '5px',
              lineHeight: { xs: 1.1, sm: 1.25, md: 1.5 },
              fontSize: { xs: '0.7rem', sm: '0.9rem', md: '1rem' },
              fontWeight: 100,
            }}
          >
            {sermon.description}
          </Typography>
          {!minimal && sermon.status.audioStatus === sermonStatusType.PROCESSED && (
            <IconButton
              sx={{ gridArea: 'playPause' }}
              aria-label="toggle play/pause"
              onClick={(e) => {
                e.preventDefault();
                setCurrentSermon(sermon);
                togglePlaying(!playing);
              }}
            >
              {playing ? <PauseCircleIcon fontSize="large" /> : <PlayCircleIcon fontSize="large" />}
            </IconButton>
          )}

          <Box display="flex" alignItems="center" sx={{ gridArea: 'playStatus', paddingTop: { xs: 1, sm: 0 } }}>
            {!minimal && (
              <Box display="flex" gap={0.2} marginRight={3}>
                <Typography sx={{ whiteSpace: 'nowrap', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
                  {sermon.dateString}
                </Typography>
                <Typography sx={{ fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>·</Typography>
                {sermon.currentSecond < Math.floor(sermon.durationSeconds) ? (
                  <>
                    <Typography sx={{ whiteSpace: 'nowrap', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
                      {formatRemainingTime(Math.floor(sermon.durationSeconds) - sermon.currentSecond) +
                        (playing || sermon.currentSecond > 0 ? ' left' : '')}
                    </Typography>
                  </>
                ) : (
                  <>
                    <Typography sx={{ fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>Played</Typography>
                    <Typography sx={{ color: 'lightgreen', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
                      {' '}
                      &#10003;
                    </Typography>
                  </>
                )}
              </Box>
            )}
            {sermon.currentSecond < Math.floor(sermon.durationSeconds) && (playing || sermon.currentSecond > 0) && (
              <Box sx={{ width: 1, maxWidth: { xs: 100, sm: 200 } }}>
                <LinearProgress
                  variant="determinate"
                  value={(sermon.currentSecond / sermon.durationSeconds) * 100}
                  sx={{
                    borderRadius: 5,
                    color: (theme) => theme.palette.grey[theme.palette.mode === 'light' ? 200 : 800],
                  }}
                />
              </Box>
            )}
          </Box>
          <CardActions sx={{ gridArea: 'actionItems', margin: 0, padding: 0 }}>
            {sermon.status.audioStatus === sermonStatusType.PROCESSED ? (
              <AdminControls sermon={sermon} playlist={playlist} setPlaylist={setPlaylist} />
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                  <Typography variant="subtitle1" sx={{ margin: 0 }}>
                    {sermon.status.audioStatus}
                  </Typography>
                  {sermon.status.audioStatus === sermonStatusType.PROCESSING && snapshot !== undefined && (
                    <CircularProgressWithLabel value={Number(snapshot.val())} />
                  )}
                </Box>
              </Box>
            )}
          </CardActions>
        </Card>
      </ListItem>
    </ErrorBoundary>
  );
};
export default SermonListCard;
