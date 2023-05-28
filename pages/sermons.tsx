/**
 * Sermons page for viewing all sermons test
 */
import dynamic from 'next/dynamic';
import type { GetStaticProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import { sermonConverter } from '../types/Sermon';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import firestore, { collection, getDocs, query, where } from '../firebase/firestore';
import SermonsList from '../components/SermonsList';
import Head from 'next/head';
import Button from '@mui/material/Button';

const DynamicBottomAudioBar = dynamic(() => import('../components/BottomAudioBar'), { ssr: false });
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
      <Button onClick={() => fetch(`/api/revalidate/sermons?secret=${process.env.NEXT_PUBLIC_REVALIDATE_SECRET}`)}>
        Revalidate Page
      </Button>
      <div style={{ padding: '0 2rem' }}>
        <h1>Sermons</h1>
        <SermonsList sermons={sermons} />
      </div>
      <DynamicBottomAudioBar />
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
