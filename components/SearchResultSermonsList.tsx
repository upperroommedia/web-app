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

const SearchResultSermonList = (props: BoxProps) => {
  const { hits } = useHits();

  return (
    <Box display="flex" justifyContent={'start'} flex={3} {...props}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}
      >
        {hits.map((hit) => (
          <SearchResultSermonListCard key={hit.objectID} sermonId={hit.objectID} />
        ))}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
