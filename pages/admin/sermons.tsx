import Typography from '@mui/material/Typography';
import { Box } from '@mui/system';
import firestore, { collection, query } from '../../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import BottomAudioBar from '../../components/BottomAudioBar';
import SermonsList from '../../components/SermonsList';
import AdminLayout from '../../layout/adminLayout';
import { sermonConverter } from '../../types/Sermon';
import { adminProtected } from '../../utils/protectedRoutes';
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import SermonListSkeloten from '../../components/skeletons/SermonListSkeloten';

const AdminSermons = () => {
  const sermonsRef = collection(firestore, 'sermons');
  const q = query(sermonsRef.withConverter(sermonConverter));
  const [sermons, loading, error] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });
  return (
    <Box width="100%" display="flex" flexDirection="column" alignItems="center" gap="10px">
      <Typography variant="h3">Manage Sermons</Typography>
      {error && (
        <Typography component="div">
          <Box fontWeight="bold" display="inline">
            Error: {JSON.stringify(error)}
          </Box>
        </Typography>
      )}
      {loading && <SermonListSkeloten />}
      {sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />}
      <BottomAudioBar />
    </Box>
  );
};

AdminSermons.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
  // TODO: see if you can get sermons server side then attach a listener on the client
};

export default AdminSermons;
