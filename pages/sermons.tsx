/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import SermonListCard from '../components/SermonListCard';
import BottomAudioBar from '../components/BottomAudioBar';

import { Sermon, sermonConverter } from '../types/Sermon';

import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';
import { useEffect } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  const { playing, playlist, setPlaylist, currentSermon, currentSecond } =
    useAudioPlayer();

  useEffect(() => {
    setPlaylist(sermons);
  }, []);

  // const handleSermonClick = (sermon: Sermon) => {
  //   // console.log('handle click');
  //   // setCurrentSermon(sermon);
  // };

  return (
    <>
      <div style={{ padding: '0 2rem' }}>
        <h1>Sermons</h1>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            margin: 'auto',
            maxWidth: '1000px',
            // gap: '3px',
          }}
        >
          {playlist.map((sermon, i) => {
            const key = `sermon_list_card_${i}`;
            if (currentSermon.key === sermon.key) {
              return (
                <SermonListCard
                  sermon={{ ...sermon, currentSecond }}
                  playing={playing}
                  key={key}
                />
              );
            } else {
              return (
                <SermonListCard sermon={sermon} playing={false} key={key} />
              );
            }
          })}
        </div>
      </div>
      {currentSermon && <BottomAudioBar />}
    </>
  );
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  const db = getFirestore(firebase);
  // Firestore data converter to convert the queried data to the expected type
  const sermonsQuery = query(collection(db, 'sermons')).withConverter(
    sermonConverter
  );
  const sermons: Sermon[] = [];
  const sermonsQuerySnapshot = await getDocs(sermonsQuery);
  sermonsQuerySnapshot.forEach((doc) => {
    sermons.push(doc.data());
  });
  return {
    props: { sermons: sermons },
  };
};

export default Sermons;
