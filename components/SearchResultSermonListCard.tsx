import firestore, { doc } from '../firebase/firestore';
import { FunctionComponent } from 'react';
import { useDocument } from 'react-firebase-hooks/firestore';
import { sermonConverter } from '../types/Sermon';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import SermonListCard from './SermonListCard';
// import { Sermon } from '../types/SermonTypes';
// import { SermonWithMetadata } from '../reducers/audioPlayerReducer';

// TODO: Fix Playablity of SermonListCard
interface SearchResultSermonListCardProps {
  sermonId: string;
  // playing: boolean;
  // playlist: SermonWithMetadata[];
  // setPlaylist: (playlist: Sermon[]) => void;
  // currentSecond: number;
  minimal?: boolean;
}

const SearchResultSermonListCard: FunctionComponent<SearchResultSermonListCardProps> = ({ sermonId, minimal }) => {
  const [sermon, loading, error] = useDocument(doc(firestore, `sermons/${sermonId}`).withConverter(sermonConverter), {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  return (
    <>
      {error && <strong>Error: {JSON.stringify(error)}</strong>}
      {loading && <SermonListCardSkeloten />}
      {sermon && sermon.exists() && (
        <SermonListCard
          sermon={{ ...sermon.data(), currentSecond: 0 }}
          playing={false}
          playlist={[]}
          setPlaylist={() => {}}
          minimal={minimal}
        />
      )}
    </>
  );
};

export default SearchResultSermonListCard;
