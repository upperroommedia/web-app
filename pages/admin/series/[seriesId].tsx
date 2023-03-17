import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { useRouter } from 'next/router';
import AdminSermonsList from '../../../components/AdminSermonsList';
import AdminLayout from '../../../layout/adminLayout';
import { adminProtected } from '../../../utils/protectedRoutes';

const SeriesSermon = () => {
  const router = useRouter();
  const seriesId = router.query.seriesId as string;
  const count = Number(router.query.count as string);

  return <AdminSermonsList collectionPath={`series/${seriesId}/seriesSermons`} count={count} />;
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
