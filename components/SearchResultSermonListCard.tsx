import firestore, { doc } from '../firebase/firestore';
import { FunctionComponent } from 'react';
import { useDocument } from 'react-firebase-hooks/firestore';
import { sermonConverter } from '../types/Sermon';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import SermonListCard from './SermonListCard';
import { Typography } from '@mui/material';
import Box from '@mui/system/Box';
import useAudioPlayer from '../context/audio/audioPlayerContext';

// import { Sermon } from '../types/SermonTypes';
// import { SermonWithMetadata } from '../reducers/audioPlayerReducer';

// TODO: Fix Playablity of SermonListCard
interface SearchResultSermonListCardProps {
  sermonId: string;
  minimal?: boolean;
}

const SearchResultSermonListCard: FunctionComponent<SearchResultSermonListCardProps> = ({ sermonId, minimal }) => {
  const [sermon, loading, error] = useDocument(doc(firestore, `sermons/${sermonId}`).withConverter(sermonConverter), {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  const { currentSermon, playing } = useAudioPlayer();
  const isPlaying = currentSermon?.id === sermonId ? playing : false;

  // eslint-disable-next-line no-console
  if (error) console.error(error);
  // eslint-disable-next-line no-console
  if (!loading && !sermon?.exists()) console.error(`No Sermon Found for objectID: ${sermonId}`);

  return (
    <>
      {error && <strong>Error: {JSON.stringify(error)}</strong>}
      {loading && <SermonListCardSkeloten />}
      {sermon && sermon.exists() && (
        <SermonListCard sermon={{ ...sermon.data(), currentSecond: 0 }} playing={isPlaying} minimal={minimal} />
      )}
      {!loading && !sermon?.exists() && (
        <Box display="flex" alignItems="center" justifyContent="center">
          <Typography>{`No Sermon Found for objectID: ${sermonId}`}</Typography>
        </Box>
      )}
    </>
  );
};

export default SearchResultSermonListCard;
