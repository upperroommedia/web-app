/**
 * SermonsList Component for displaying a list of sermons
 */

import SermonListCard from './SermonListCard';

import { Sermon } from '../types/SermonTypes';

import { useEffect } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        margin: 'auto',
        maxWidth: '1000px',
        width: '100%',
        // gap: '3px',
      }}
    >
      {minimal
        ? sermons.map((sermon) => (
            <SermonListCard
              sermon={{ ...sermon, currentSecond }}
              playing={false}
              key={sermon.key}
              playlist={playlist}
              setPlaylist={setPlaylist}
              minimal={true}
            />
          ))
        : playlist.map((sermon, i) => {
            const key = `sermon_list_card_${i}`;
            if (currentSermon?.key === sermon.key) {
              return (
                <SermonListCard
                  sermon={{ ...sermon, currentSecond }}
                  playing={playing}
                  key={key}
                  playlist={playlist}
                  setPlaylist={setPlaylist}
                />
              );
            } else {
              return (
                <SermonListCard
                  sermon={sermon}
                  playing={false}
                  key={key}
                  playlist={playlist}
                  setPlaylist={setPlaylist}
                />
              );
            }
          })}
    </div>
  );
};

export default SermonsList;
