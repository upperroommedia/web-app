import firestore, { doc } from '../firebase/firestore';
import { FunctionComponent, memo, useMemo } from 'react';
import { useDocument } from 'react-firebase-hooks/firestore';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import SermonListCard from './SermonListCard';
import { Sermon } from '../types/SermonTypes';
import { sermonConverter } from '../types/Sermon';
import RemainingTimeComponent from './RemainingTimeComponent';
import TrackProgressComponent from './TrackProgressComponent';

// import { Sermon } from '../types/SermonTypes';
// import { SermonWithMetadata } from '../reducers/audioPlayerReducer';

// TODO: Fix Playablity of SermonListCard
interface SearchResultSermonListCardProps {
  sermonId: string;
  isPlaying: boolean;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  minimal?: boolean;
}

const SearchResultSermonListCard: FunctionComponent<SearchResultSermonListCardProps> = ({
  sermonId,
  isPlaying,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
  minimal,
}) => {
  const [sermonSnapshot, loading, error] = useDocument(
    doc(firestore, `sermons/${sermonId}`).withConverter(sermonConverter),
    {
      snapshotListenOptions: { includeMetadataChanges: true },
    }
  );

  const sermonData = useMemo(() => sermonSnapshot?.data(), [sermonSnapshot]);

  if (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    return <strong>Error: {JSON.stringify(error)}</strong>;
  }
  if (!loading && !sermonSnapshot?.exists()) {
    // eslint-disable-next-line no-console
    console.warn(`No Sermon Found for objectID: ${sermonId} - if this was recently deleted you can ignore`);

    return <></>;
  }
  if (loading) {
    return loading && <SermonListCardSkeloten />;
  }
  const sermon = sermonData;
  return (
    <>
      {sermon && (
        <SermonListCard
          sermon={sermon}
          playing={isPlaying}
          remainingTimeComponent={<RemainingTimeComponent playing={isPlaying} duration={sermon.durationSeconds} />}
          trackProgressComponent={<TrackProgressComponent playing={isPlaying} duration={sermon.durationSeconds} />}
          audioPlayerCurrentSermonId={audioPlayerCurrentSermonId}
          audioPlayerSetCurrentSermon={audioPlayerSetCurrentSermon}
          minimal={minimal}
        />
      )}
    </>
  );
};

export default memo(SearchResultSermonListCard);
