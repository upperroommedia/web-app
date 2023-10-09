import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';
import firestore, { collection, limit, orderBy, query, where } from '../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import BottomAudioBar from './BottomAudioBar';
import SermonsList from './SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeloten from './skeletons/SermonListSkeloten';
import { FunctionComponent, useState } from 'react';
import useAuth from '../context/user/UserContext';
import { UserRole } from '../types/User';
import Button from '@mui/material/Button';
import { Sermon } from '../types/SermonTypes';

interface AdminSermonsListProps {
  collectionPath: string;
  count?: number;
}

const limitCount = 20;

const AdminSermonsList: FunctionComponent<AdminSermonsListProps> = ({
  collectionPath,
  count,
}: AdminSermonsListProps) => {
  const { user } = useAuth();
  const [queryLimit, setQueryLimit] = useState<number>(limitCount);
  const [previousSermonsCount, setPreviousSermonsCount] = useState<number>(0);
  const [previousSermons, setPreviousSermons] = useState<Sermon[]>([]);
  const sermonsRef = collection(firestore, collectionPath);
  const q =
    user?.role === UserRole.UPLOADER
      ? query(
          sermonsRef.withConverter(sermonConverter),
          where('uploaderId', '==', user.uid),
          orderBy('createdAtMillis', 'desc'),
          limit(queryLimit)
        )
      : query(sermonsRef.withConverter(sermonConverter), orderBy('createdAtMillis', 'desc'), limit(queryLimit));
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
        <>
          <SermonsList sermons={previousSermons} />
          <SermonListSkeloten count={count} />
        </>
      )}
      {sermons && (
        <>
          <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />
          {(sermons.size ?? 0) - previousSermonsCount === limitCount && (
            <Button
              onClick={() => {
                setQueryLimit((previousLimit) => previousLimit + limitCount);
                setPreviousSermons(sermons.docs.map((doc) => doc.data()));
                setPreviousSermonsCount(sermons.size);
              }}
            >
              Load More
            </Button>
          )}
        </>
      )}
      <BottomAudioBar />
    </Box>
  );
};

export default AdminSermonsList;
