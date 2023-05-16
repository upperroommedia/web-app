/**
 * Sermons page for viewing all sermons test
 */
import dynamic from 'next/dynamic';
// import PropTypes from 'prop-types';

import { sermonConverter } from '../../types/Sermon';
import { uploadStatus } from '../../types/SermonTypes';
import firestore, { collection, getDocs, query, where } from '../../firebase/firestore';
import SermonsList from '../../components/SermonsList';
import Head from 'next/head';

const DynamicBottomAudioBar = dynamic(() => import('../../components/BottomAudioBar'), { ssr: false });

export default async function Sermons() {
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
        <SermonsList sermons={await getSermons()} />
      </div>
      <DynamicBottomAudioBar />
    </>
  );
}

async function getSermons() {
  try {
    // Firestore data converter to convert the queried data to the expected type
    const sermonsQuery = query(
      collection(firestore, 'sermons'),
      where('status.subsplash', '==', uploadStatus.UPLOADED)
    ).withConverter(sermonConverter);
    const sermonsQuerySnapshot = await getDocs(sermonsQuery);
    const sermons = sermonsQuerySnapshot.docs.map((doc) => doc.data());

    return sermons;
  } catch (error) {
    return [];
  }
}
