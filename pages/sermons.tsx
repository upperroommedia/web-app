/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
import PropTypes from 'prop-types';

import Footer from '../components/Footer';
import Navbar from '../components/Navbar';

import styles from '../styles/Uploader.module.css';
import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';

interface sermon {
  ref: string;
  title: string;
  description: string;
  speaker: Array<string>;
  subtitle: string;
  scripture: string;
  date: Date;
  topic: Array<string>;
}

const Sermons: NextPage<{ sermons: Array<sermon> }> = ({ sermons }) => {
  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Sermons</h1>
      {sermons.map((sermon) => (
        <>
          <p>
            <a
              href={`https://storage.googleapis.com/download/storage/v1/b/sermons/o/${
                sermon.ref.split('/')[1]
              }?alt=media`}
            >
              {sermon.title}
            </a>
            <audio controls>
              <source
                src={`https://storage.googleapis.com/download/storage/v1/b/sermons/o/${
                  sermon.ref.split('/')[1]
                }?alt=media`}
              />
            </audio>
          </p>
        </>
      ))}
      <Footer />
    </div>
  );
};

Sermons.propTypes = {
  sermons: PropTypes.any,
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  const db = getFirestore(firebase);

  const sermonsQuery = query(collection(db, 'sermons'));
  const sermons: Array<sermon> = [];
  const sermonsQuerySnapshot = await getDocs(sermonsQuery);
  sermonsQuerySnapshot.forEach((doc) => {
    const current: sermon = doc.data() as unknown as sermon;
    if (current.title !== 'just here for testing') {
      sermons.push(current);
    }
  });
  return {
    props: { sermons: sermons },
  };
};

export default Sermons;
