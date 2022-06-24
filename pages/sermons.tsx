/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import SermonListCard from '../components/SermonListCard';
import BottomAudioBar from '../components/BottomAudioBar';

import { Sermon, sermonConverter } from '../types/Sermon';

import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { firebase, storage } from '../firebase/firebase';
import { useEffect, useRef, useState } from 'react';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  const sermonsRef = ref(storage, 'sermons');
  const [playRef, setPlayRef] = useState<{ index: number; isPlaying: boolean }>(
    { index: -1, isPlaying: false }
  );
  const urls = useRef<string[]>(new Array(sermons.length));
  const [url, setUrl] = useState<string | undefined>();

  const handleSermonClick = (sermon: Sermon) => {
    // console.log('handle click');
    // setCurrentSermon(sermon);
  };
  const playSermonClick = async (index: number) => {
    setPlayRef((prevIndex) => ({
      index: index,
      isPlaying: prevIndex.index === index ? !prevIndex.isPlaying : true,
    }));
  };

  useEffect(() => {
    if (playRef.index === -1) return;
    const index = playRef.index;
    // cache urls on demand to avoid unnecessary network requests
    if (!urls.current[index]) {
      getDownloadURL(ref(sermonsRef, sermons[index].key)).then((url) => {
        urls.current[index] = url;
        setUrl(url);
      });
    } else {
      setUrl(urls.current[index]);
    }
  }, [playRef]);

  return (
    <>
      <div style={{ padding: '0 2rem' }}>
        <Navbar />
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
          {sermons.map((sermon, i) => (
            <SermonListCard
              sermon={sermon}
              index={i}
              isPlaying={i === playRef.index ? playRef.isPlaying : false}
              handleSermonClick={handleSermonClick}
              playSermonClick={playSermonClick}
              key={`sermon_list_card_${i}`}
            ></SermonListCard>
          ))}
        </div>

        <Footer />
      </div>
      {playRef.index !== -1 && (
        <BottomAudioBar
          sermon={sermons[playRef.index]}
          playRef={playRef}
          url={url}
          playSermonClick={playSermonClick}
        />
      )}
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
