/**
 * SermonsList Component for displaying a list of sermons
 */

import SearchResultSermonListCard from './SearchResultSermonListCard';
import { useHits } from 'react-instantsearch';

// import { Sermon } from '../types/SermonTypes';

// import { useEffect } from 'react';
// import useAudioPlayer from '../context/audio/audioPlayerContext';
import List from '@mui/material/List';
import Box from '@mui/material/Box';
import { BoxProps } from '@mui/system/Box';
import useAudioPlayer from '../context/audio/audioPlayerContext';

const SearchResultSermonList = (props: BoxProps) => {
  const { hits } = useHits();
  const { currentSermon, playing, setCurrentSermon, togglePlaying, currentSecond } = useAudioPlayer();

  return (
    <Box display="flex" justifyContent={'start'} flex={3} {...props}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}
      >
        {hits.map((hit) => (
          <SearchResultSermonListCard
            key={hit.objectID}
            sermonId={hit.objectID}
            isPlaying={currentSermon?.id === hit.objectID ? playing : false}
            audioPlayerCurrentSecond={hit.objectID === currentSermon?.id ? currentSecond : 0}
            audioPlayerCurrentSermonId={currentSermon?.id}
            audioPlayerSetCurrentSermon={setCurrentSermon}
            audioPlayerTogglePlaying={togglePlaying}
          />
        ))}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
