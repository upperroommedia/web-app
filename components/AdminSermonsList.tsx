import Typography from '@mui/material/Typography';
import { Box } from '@mui/system';
import firestore, {
  collection,
  orderBy,
  query,
  limit,
  startAfter,
  QueryDocumentSnapshot,
  getDocs,
} from '../firebase/firestore';
import BottomAudioBar from './BottomAudioBar';
import SermonsList from './SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeleton from './skeletons/SermonListSkeloten';
import { FunctionComponent, useEffect, useState } from 'react';
import { Sermon } from '../types/SermonTypes';
import Button from '@mui/material/Button';

interface AdminSermonsListProps {
  collectionPath: string;
  count?: number;
}

const AdminSermonsList: FunctionComponent<AdminSermonsListProps> = ({
  collectionPath,
  count,
}: AdminSermonsListProps) => {
  const SERMONSTOLOAD = count || 5;
  const sermonsRef = collection(firestore, collectionPath);
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [error, setError] = useState<any>();
  const [loading, setLoading] = useState<boolean>(true);
  const [lastDocument, setLastDocument] = useState<QueryDocumentSnapshot<Sermon>>();
  const q = lastDocument
    ? query(
        sermonsRef.withConverter(sermonConverter),
        orderBy('date', 'desc'),
        limit(SERMONSTOLOAD),
        startAfter(lastDocument)
      )
    : query(sermonsRef.withConverter(sermonConverter), orderBy('date', 'desc'), limit(SERMONSTOLOAD));

  const fetchSermons = async () => {
    try {
      const sermonsSnapshot = await getDocs(q);
      setSermons((oldSermons) => [...oldSermons, ...sermonsSnapshot.docs.map((doc) => doc.data())]);
      setLastDocument(sermonsSnapshot.docs[sermonsSnapshot.docs.length - 1]);
    } catch (error) {
      setError(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const g = async () => {
      await fetchSermons();
    };
    g();
  }, []);

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
      {loading && <SermonListSkeleton count={count} />}
      {sermons && <SermonsList sermons={sermons} />}
      {sermons && sermons.length > 0 && lastDocument !== undefined && sermons.length % SERMONSTOLOAD === 0 && (
        <div>
          <Button onClick={fetchSermons}>Load More</Button>
        </div>
      )}
      <BottomAudioBar />
    </Box>
  );
};

export default AdminSermonsList;
