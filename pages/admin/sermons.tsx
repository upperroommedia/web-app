import Typography from '@mui/material/Typography';
import { Box } from '@mui/system';
import firestore, { collection, query } from '../../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import BottomAudioBar from '../../components/BottomAudioBar';
import SermonsList from '../../components/SermonsList';
import AdminLayout from '../../layout/adminLayout';
import { sermonConverter } from '../../types/Sermon';
import CircularProgress from '@mui/material/CircularProgress';

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
      {loading && (
        <Box display="flex" gap={2}>
          <Typography variant="h4">Loading</Typography>
          <CircularProgress />
        </Box>
      )}
      {sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />}
      <BottomAudioBar />
    </Box>
  );
};

AdminSermons.PageLayout = AdminLayout;

export default AdminSermons;
