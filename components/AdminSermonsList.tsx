import Typography from '@mui/material/Typography';
import { Box } from '@mui/system';
import firestore, { collection, query } from '../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import BottomAudioBar from './BottomAudioBar';
import SermonsList from './SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeloten from './skeletons/SermonListSkeloten';
import { FunctionComponent } from 'react';

interface AdminSermonsListProps {
  collectionPath: string;
  count?: number;
}

const AdminSermonsList: FunctionComponent<AdminSermonsListProps> = ({
  collectionPath,
  count,
}: AdminSermonsListProps) => {
  const sermonsRef = collection(firestore, collectionPath);
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
      {loading && <SermonListSkeloten count={count} />}
      {sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />}
      <BottomAudioBar />
    </Box>
  );
};

export default AdminSermonsList;