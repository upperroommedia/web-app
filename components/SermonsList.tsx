/**
 * SermonsList Component for displaying a list of sermons
 */

import SermonListCard from './SermonListCard';

import { Sermon } from '../types/SermonTypes';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import List from '@mui/material/List';
import Box from '@mui/material/Box';

interface Props {
  sermons: Sermon[];
  minimal?: boolean;
}

const SermonsList = ({ sermons, minimal }: Props) => {
  const { playing, currentSermon, currentSecond, setCurrentSermon, togglePlaying } = useAudioPlayer();

  return (
    <Box display="flex" justifyContent={'start'} width={1}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}
      >
        {sermons.map((sermon) => (
          <SermonListCard
            sermon={{ ...sermon, currentSecond }}
            playing={currentSermon?.id === sermon.id ? playing : false}
            audioPlayerCurrentSecond={currentSecond}
            audioPlayerCurrentSermonId={currentSermon?.id}
            audioPlayerSetCurrentSermon={setCurrentSermon}
            audioPlayerTogglePlaying={togglePlaying}
            key={sermon.id}
            {...(minimal && { minimal: true })}
          />
        ))}
      </List>
    </Box>
  );
};

export default SermonsList;
