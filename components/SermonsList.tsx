'use client';
/**
 * SermonsList Component for displaying a list of sermons
 */

import SermonListCard from './SermonListCard';

import { Sermon } from '../types/SermonTypes';

import { useEffect } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import List from '@mui/material/List';
import Box from '@mui/material/Box';

interface Props {
  sermons: Sermon[];
  minimal?: boolean;
}

const SermonsList = ({ sermons, minimal }: Props) => {
  const { playing, playlist, setPlaylist, currentSermon, currentSecond } = useAudioPlayer();

  useEffect(() => {
    setPlaylist(sermons);
  }, [sermons]);

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
        {minimal
          ? sermons.map((sermon) => (
              <SermonListCard
                sermon={{ ...sermon, currentSecond }}
                playing={false}
                key={sermon.id}
                playlist={playlist}
                setPlaylist={setPlaylist}
                minimal={true}
              />
            ))
          : playlist.map((sermon) => {
              if (currentSermon?.id === sermon.id) {
                return (
                  <SermonListCard
                    sermon={{ ...sermon, currentSecond }}
                    playing={playing}
                    key={sermon.id}
                    playlist={playlist}
                    setPlaylist={setPlaylist}
                  />
                );
              } else {
                return (
                  <SermonListCard
                    sermon={sermon}
                    playing={false}
                    key={sermon.id}
                    playlist={playlist}
                    setPlaylist={setPlaylist}
                  />
                );
              }
            })}
      </List>
    </Box>
  );
};

export default SermonsList;
