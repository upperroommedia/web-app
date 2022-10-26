/**
 * Sermons page for viewing all sermons test
 */
import dynamic from 'next/dynamic';
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import SermonListCard from '../components/SermonListCard';

import { Sermon, sermonConverter } from '../types/Sermon';
import firestore, { collection, getDocs, query, where } from '../firebase/firestore';
import { useEffect } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import Head from 'next/head';

const DynamicBottomAudioBar = dynamic(() => import('../components/BottomAudioBar'), { ssr: false });
interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  const { playing, playlist, setPlaylist, currentSermon, currentSecond } = useAudioPlayer();

  useEffect(() => {
    setPlaylist(sermons);
  }, []);

  // const handleSermonClick = (sermon: Sermon) => {
  //   // console.log('handle click');
  //   // setCurrentSermon(sermon);
  // };

  return (
    <>
      <Head>
        <title>Sermons</title>
        <meta property="og:title" content="Sermons" key="title" />
        <meta name="description" content="Upper Room Media Sermons are English Coptic Orthodox Christian Sermons" />
      </Head>
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
      </div>
      {currentSermon && <DynamicBottomAudioBar />}
    </>
  );
};

export const getServerSideProps: GetServerSideProps = async (_context) => {
  try {
    // Firestore data converter to convert the queried data to the expected type
    const sermonsQuery = query(collection(firestore, 'sermons'), where('processed', '==', true)).withConverter(
      sermonConverter
    );
    const sermonsQuerySnapshot = await getDocs(sermonsQuery);
    const sermons = sermonsQuerySnapshot.docs.map((doc) => doc.data());

    return {
      props: { sermons: sermons },
    };
  } catch (error) {
    return {
      props: { sermons: [] },
    };
  }
};

export default Sermons;
