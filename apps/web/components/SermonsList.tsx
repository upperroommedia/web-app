/**
 * SermonsList Component for displaying a list of sermons
 */

import SermonListCard from './SermonListCard';

import { Sermon } from '../types/SermonTypes';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import List from '@mui/material/List';
import Box from '@mui/material/Box';
import RemainingTimeComponent from './RemainingTimeComponent';
import TrackProgressComponent from './TrackProgressComponent';

interface Props {
  sermons: Sermon[];
  minimal?: boolean;
}

const SermonsList = ({ sermons, minimal }: Props) => {
  const { playing, currentSermon, setCurrentSermon } = useAudioPlayer();

  return (
    <Box display="flex" justifyContent={'start'} width={1}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}
      >
        {sermons.map((sermon) => {
          const isPlaying = currentSermon?.id === sermon.id ? playing : false;
          return (
            <SermonListCard
              sermon={sermon}
              playing={isPlaying}
              remainingTimeComponent={<RemainingTimeComponent playing={isPlaying} duration={sermon.durationSeconds} />}
              trackProgressComponent={<TrackProgressComponent playing={isPlaying} duration={sermon.durationSeconds} />}
              audioPlayerCurrentSermonId={currentSermon?.id}
              audioPlayerSetCurrentSermon={setCurrentSermon}
              key={sermon.id}
              {...(minimal && { minimal: true })}
            />
          );
        })}
      </List>
    </Box>
  );
};

export default SermonsList;
