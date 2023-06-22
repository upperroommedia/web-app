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
  where,
} from '../firebase/firestore';
import BottomAudioBar from '../components/BottomAudioBar';
import SermonsList from '../components/SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeleton from '../components/skeletons/SermonListSkeloten';
import { useEffect, useState } from 'react';
import { Sermon } from '../types/SermonTypes';
import Button from '@mui/material/Button';
import useAuth from '../context/user/UserContext';

const Uploads = () => {
  const { user } = useAuth();

  const SERMONSTOLOAD = 20;
  const sermonsRef = collection(firestore, 'sermons');
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [error, setError] = useState<any>();
  const [loading, setLoading] = useState<boolean>(true);
  const [lastDocument, setLastDocument] = useState<QueryDocumentSnapshot<Sermon>>();
  const q = lastDocument
    ? query(
        sermonsRef.withConverter(sermonConverter),
        orderBy('date', 'desc'),
        where('uploaderId', '==', user?.uid),
        limit(SERMONSTOLOAD),
        startAfter(lastDocument)
      )
    : query(
        sermonsRef.withConverter(sermonConverter),
        orderBy('date', 'desc'),
        where('uploaderId', '==', user?.uid),
        limit(SERMONSTOLOAD)
      );

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
      <Typography variant="h3">Manage Your Uploads</Typography>
      {error && (
        <Typography component="div">
          <Box fontWeight="bold" display="inline">
            Error: {JSON.stringify(error)}
          </Box>
        </Typography>
      )}
      {loading && <SermonListSkeleton count={SERMONSTOLOAD} />}
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

export default Uploads;
