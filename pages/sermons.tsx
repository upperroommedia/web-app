/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import SermonListCard from '../components/SermonListCard';
import BottomAudioBar from '../components/BottomAudioBar';

import { Sermon, sermonConverter } from '../types/Sermon';

import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { firebase, storage } from '../firebase/firebase';
import { useState } from 'react';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  const sermonsRef = ref(storage, 'sermons');
  const [currentSermon, setCurrentSermon] = useState<
    [Sermon, string] | undefined
  >(undefined);

  const handleSermonClick = (sermon: Sermon) => {
    // console.log('handle click');
    // setCurrentSermon(sermon);
  };
  const playSermonClick = async (sermon: Sermon) => {
    // console.log('Play');
    const url = await getDownloadURL(ref(sermonsRef, sermon.key));
    setCurrentSermon([sermon, url]);
  };

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
          {sermons.map((sermon, i) => (
            <SermonListCard
              sermon={sermon}
              handleSermonClick={handleSermonClick}
              playSermonClick={playSermonClick}
              key={`sermon_list_card_${i}`}
            ></SermonListCard>
          ))}
        </div>
      </div>
      {currentSermon && (
        <BottomAudioBar sermon={currentSermon[0]} url={currentSermon[1]} />
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
    props: { sermons },
  };
};

export default Sermons;
