import Box from '@mui/material/Box';
import { FunctionComponent } from 'react';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import firestore, { collection } from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import SermonsList from './SermonsList';
import SermonListSkeloten from './skeletons/SermonListSkeloten';

interface SeriesSermonListProps {
  seriesId: string;
}

const SeriesSermonList: FunctionComponent<SeriesSermonListProps> = ({ seriesId }: SeriesSermonListProps) => {
  const [sermons, loading, error] = useCollectionData(
    collection(firestore, `series/${seriesId}/seriesSermons`).withConverter(sermonConverter)
  );

  return (
    <>
      {error ? (
        <Box> {error?.message} </Box>
      ) : loading ? (
        <SermonListSkeloten minimal />
      ) : (
        <SermonsList sermons={sermons!} minimal />
      )}
    </>
  );
};

export default SeriesSermonList;
