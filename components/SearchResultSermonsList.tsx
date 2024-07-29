/**
 * SermonsList Component for displaying a list of sermons
 */

import SearchResultSermonListCard from './SearchResultSermonListCard';
import { useHits, useInstantSearch } from 'react-instantsearch';

// import { Sermon } from '../types/SermonTypes';

// import { useEffect } from 'react';
// import useAudioPlayer from '../context/audio/audioPlayerContext';
import List from '@mui/material/List';
import Box from '@mui/material/Box';
import { BoxProps } from '@mui/system/Box';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { useMediaState } from '@vidstack/react';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import Typography from '@mui/material/Typography';

const SearchResultSermonList = (props: BoxProps) => {
  const { hits } = useHits();
  const { status } = useInstantSearch();
  const { currentSermonId, setCurrentSermon } = useAudioPlayer();
  const playing = useMediaState('playing');

  return (
    <Box display="flex" justifyContent={'start'} flex={3} {...props}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}
      >
        {status === 'error' && (
          <Typography component="div">
            <Box fontWeight="bold" display="inline">
              Error: Algolia search errored please try again later
            </Box>
          </Typography>
        )}
        {(status === 'loading' || status === 'stalled') &&
          [...Array(20)].map((_, i) => <SermonListCardSkeloten key={`sermonListCardSkeloten_${i}`} />)}
        {status === 'idle' &&
          hits.map((hit) => (
            <SearchResultSermonListCard
              key={hit.objectID}
              sermonId={hit.objectID}
              isPlaying={currentSermonId === hit.objectID ? playing : false}
              audioPlayerCurrentSermonId={currentSermonId}
              audioPlayerSetCurrentSermon={setCurrentSermon}
            />
          ))}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
