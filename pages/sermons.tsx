/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import SermonListCard from '../components/SermonListCard';
import BottomAudioBar from '../components/BottomAudioBar';

import { useEffect } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { Sermon } from '../context/types';
import { getSermons } from '../firebase/audio_functions';
import * as admin from 'firebase-admin';
import nookies from 'nookies';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  const {
    playing,
    playlist,
    setPlaylist,
    currentSermon,
    currentSecond,
    currentPlayedState,
  } = useAudioPlayer();

  useEffect(() => {
    console.log('From SSR:', sermons);
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
                  sermon={sermon}
                  playing={playing}
                  currentPlayedState={currentPlayedState}
                  currentSecond={currentSecond}
                  key={key}
                />
              );
            } else {
              return (
                <SermonListCard
                  sermon={sermon}
                  playing={false}
                  currentPlayedState={sermon.playedState.state}
                  currentSecond={0}
                  key={key}
                />
              );
            }
          })}
        </div>
      </div>
      {currentSermon && <BottomAudioBar />}
    </>
  );
};

// TODO(1): make sure to handle when token is expired
export const getServerSideProps: GetServerSideProps = async (context) => {
  const cookies = nookies.get(context);
  const token = await admin.auth().verifyIdToken(cookies.token);

  // the user is authenticated!
  const { uid, email } = token;
  console.log('User: ', uid, email);

  return {
    props: { sermons: await getSermons(uid) },
  };
};

export default Sermons;
