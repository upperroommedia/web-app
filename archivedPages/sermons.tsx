/**
 * Sermons page for viewing all sermons test
 */
import type { GetStaticProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import firestore, { collection, getDocs, query, where } from '../firebase/firestore';
import SermonsList from '../components/SermonsList';
import Head from 'next/head';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {
  return (
    <>
      <Head>
        <title>Sermons</title>
        <meta property="og:title" content="Sermons" key="title" />
        <meta
          name="description"
          content="Upper Room Media Sermons are English Coptic Orthodox Christian Sermons"
          key="description"
        />
      </Head>
      <div style={{ padding: '0 2rem' }}>
        <h1>Sermons</h1>
        <SermonsList sermons={sermons} />
      </div>
    </>
  );
};

export const getStaticProps: GetStaticProps = async (_context) => {
  try {
    // Firestore data converter to convert the queried data to the expected type
    const sermonsQuery = query(
      collection(firestore, 'sermons'),
      where('status.subsplash', '==', uploadStatus.UPLOADED)
    ).withConverter(sermonConverter);
    const sermonsQuerySnapshot = await getDocs(sermonsQuery);
    const sermons = sermonsQuerySnapshot.docs.map((doc) => doc.data());

    return {
      props: { sermons },
    };
  } catch (error) {
    return {
      props: { sermons: [] },
    };
  }
};

export default Sermons;
