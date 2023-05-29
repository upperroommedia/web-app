'use client';
import Head from 'next/head';
import { useDocumentData } from 'react-firebase-hooks/firestore';
import firestore, { doc } from '../../../../firebase/firestore';
import { listConverter } from '../../../../types/List';
import AdminSermonsList from '../../sermons/AdminSermonsList';

type Params = {
  params: {
    listId: string;
  };
  searchParams: {
    count?: string;
  };
};

const SeriesSermon = ({ params: { listId }, searchParams: { count } }: Params) => {
  const [series, _loading, _error] = useDocumentData(doc(firestore, `lists/${listId}`).withConverter(listConverter));
  const title = series?.name || listId;
  const sermonCount = Number(count);

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta property="og:title" content={title} key="title" />
        <meta
          name="description"
          content={`Upper Room Media Sermons are English Coptic Orthodox Christian Sermons from the series ${series?.name}`}
          key="description"
        />
      </Head>
      <AdminSermonsList collectionPath={`lists/${listId}/listItems`} count={sermonCount} />
    </>
  );
};

export default SeriesSermon;
