import firestore, { doc } from '../firebase/firestore';
import { FunctionComponent, memo } from 'react';
import { useDocument } from 'react-firebase-hooks/firestore';
import { sermonConverter } from '../types/Sermon';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import SermonListCard from './SermonListCard';
import { Sermon } from '../types/SermonTypes';

// import { Sermon } from '../types/SermonTypes';
// import { SermonWithMetadata } from '../reducers/audioPlayerReducer';

// TODO: Fix Playablity of SermonListCard
interface SearchResultSermonListCardProps {
  sermonId: string;
  isPlaying: boolean;
  audioPlayerCurrentSecond: number;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerTogglePlaying: (play?: boolean) => void;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  minimal?: boolean;
}

const SearchResultSermonListCard: FunctionComponent<SearchResultSermonListCardProps> = ({
  sermonId,
  isPlaying,
  audioPlayerCurrentSecond,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
  audioPlayerTogglePlaying,
  minimal,
}) => {
  const [sermon, loading, error] = useDocument(doc(firestore, `sermons/${sermonId}`).withConverter(sermonConverter), {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  // eslint-disable-next-line no-console
  if (error) console.error(error);
  if (!loading && !sermon?.exists())
    // eslint-disable-next-line no-console
    console.warn(`No Sermon Found for objectID: ${sermonId} - if this was recently deleted you can ignore`);

  return (
    <>
      {error && <strong>Error: {JSON.stringify(error)}</strong>}
      {loading && <SermonListCardSkeloten />}
      {sermon && sermon.exists() && (
        <SermonListCard
          sermon={{ ...sermon.data(), currentSecond: 0 }}
          playing={isPlaying}
          audioPlayerCurrentSecond={audioPlayerCurrentSecond}
          audioPlayerCurrentSermonId={audioPlayerCurrentSermonId}
          audioPlayerSetCurrentSermon={audioPlayerSetCurrentSermon}
          audioPlayerTogglePlaying={audioPlayerTogglePlaying}
          minimal={minimal}
        />
      )}
    </>
  );
};

export default memo(SearchResultSermonListCard);
