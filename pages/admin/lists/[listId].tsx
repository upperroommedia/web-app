import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useDocumentData } from 'react-firebase-hooks/firestore';
import AdminSermonsList from '../../../components/AdminSermonsList';
import firestore, { doc } from '../../../firebase/firestore';
import AdminLayout from '../../../layout/adminLayout';
import { listConverter } from '../../../types/List';
import { adminProtected } from '../../../utils/protectedRoutes';

const SeriesSermon = () => {
  const router = useRouter();
  const listId = router.query.listId as string;
  const [series, _loading, _error] = useDocumentData(doc(firestore, `lists/${listId}`).withConverter(listConverter));
  const title = series?.name || listId;
  const count = Number(router.query.count as string);

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
      <AdminSermonsList collectionPath={`lists/${listId}/listItems`} count={count} />
    </>
  );
};

SeriesSermon.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};
export default SeriesSermon;
//  <Box>
//       <Box display="flex" justifyContent="center" gap={1}>
//         <Button
//           color="info"
//           variant="contained"
//           size="small"
//           onClick={() => {
//             setEditSeriesPopup(true);
//           }}
//         >
//           Edit Series
//         </Button>

//         <Button
//           color="error"
//           variant="contained"
//           size="small"
//           disabled={isDeleting}
//           onClick={() => setDeleteSeriesPopup(true)}
//         >
//           {isDeleting ? <CircularProgress /> : 'Delete Series'}
//         </Button>
//       </Box>
//       <SeriesSermonList seriesId={s.id} count={s.count} />
//     </Box>
