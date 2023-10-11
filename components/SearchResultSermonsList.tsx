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

interface Props {}

const SearchResultSermonList = (props: Props) => {
  const { hits } = useHits(props);
  // const { playing, playlist, setPlaylist, currentSermon, currentSecond } = useAudioPlayer();

  // useEffect(() => {
  //   setPlaylist(sermons);
  // }, [sermons]);

  // const handleSermonClick = (sermon: Sermon) => {
  //   // console.log('handle click');
  //   // setCurrentSermon(sermon);
  // };

  return (
    <Box display="flex" justifyContent={'start'} width={1}>
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
