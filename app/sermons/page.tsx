/**
 * Sermons page for viewing all sermons test
 */
import SermonsList from '../../components/SermonsList';
import Head from 'next/head';
import BottomAudioBar from '../../components/BottomAudioBar';
import getSermons from './getSermons';

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
        <h1 className="text-4xl">Sermons</h1>
        <SermonsList sermons={await getSermons()} />
      </div>
      <BottomAudioBar />
    </>
  );
}
