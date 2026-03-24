import { useEffect, useMemo, useRef, useState } from 'react';
import { useHits, useInstantSearch } from 'react-instantsearch';
import List from '@mui/material/List';
import Box from '@mui/material/Box';
import { BoxProps } from '@mui/system/Box';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { useMediaState } from '@vidstack/react';
import SermonListCardSkeloten from './skeletons/SermonListCardSkeloten';
import Typography from '@mui/material/Typography';
import SermonListCard from './SermonListCard';
import RemainingTimeComponent from './RemainingTimeComponent';
import TrackProgressComponent from './TrackProgressComponent';
import firestore, {
  collection,
  deleteField,
  doc,
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import { Sermon, sermonStatusType } from '../types/SermonTypes';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { normalizeAlgoliaSermonHit, type AlgoliaSermonHit } from '../utils/algolia/searchRecords';

const FIRESTORE_IN_QUERY_LIMIT = 10;

const chunkIds = (ids: string[], chunkSize: number): string[][] => {
  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }

  return chunks;
};

const useLiveVisibleSermons = (sermonIds: string[]) => {
  const [liveSermonsById, setLiveSermonsById] = useState<Record<string, Sermon>>({});

  useEffect(() => {
    if (sermonIds.length === 0) {
      return;
    }

    const chunkSnapshots = new Map<number, Record<string, Sermon>>();
    const unsubscribeCallbacks = chunkIds(sermonIds, FIRESTORE_IN_QUERY_LIMIT).map((idChunk, chunkIndex) => {
      const sermonsQuery = query(
        collection(firestore, 'sermons').withConverter(sermonConverter),
        where(documentId(), 'in', idChunk)
      );

      return onSnapshot(sermonsQuery, (snapshot) => {
        const nextChunkRecords: Record<string, Sermon> = {};
        snapshot.docs.forEach((docSnapshot) => {
          nextChunkRecords[docSnapshot.id] = docSnapshot.data();
        });
        chunkSnapshots.set(chunkIndex, nextChunkRecords);

        const mergedRecords: Record<string, Sermon> = {};
        chunkSnapshots.forEach((records) => Object.assign(mergedRecords, records));
        setLiveSermonsById(mergedRecords);
      });
    });

    return () => {
      unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe());
    };
  }, [sermonIds]);

  return useMemo(() => {
    if (sermonIds.length === 0) {
      return {};
    }

    const visibleIdSet = new Set(sermonIds);
    return Object.fromEntries(
      Object.entries(liveSermonsById).filter(([sermonId]) => visibleIdSet.has(sermonId))
    );
  }, [liveSermonsById, sermonIds]);
};

const SearchResultSermonList = (props: BoxProps) => {
  const { hits } = useHits();
  const { status, results, indexUiState } = useInstantSearch();
  const { currentSermonId, setCurrentSermon } = useAudioPlayer();
  const playing = useMediaState('playing');
  const hasSettledResults = !results.__isArtificial && status === 'idle';
  const acknowledgedPendingIdsRef = useRef<Set<string>>(new Set());
  const pendingSermonsQuery = useMemo(
    () =>
      query(
        collection(firestore, 'sermons').withConverter(sermonConverter),
        where('searchPending', '==', true),
        orderBy('createdAtMillis', 'desc'),
        limit(8)
      ),
    []
  );
  const [pendingSermons] = useCollectionData(pendingSermonsQuery);

  const normalizedHits = useMemo(
    () => hits.map((hit) => normalizeAlgoliaSermonHit(hit as AlgoliaSermonHit)),
    [hits]
  );
  const visibleHitIds = useMemo(() => new Set(normalizedHits.map((hit) => hit.id)), [normalizedHits]);
  const refinementList = (indexUiState as { refinementList?: Record<string, string[]> }).refinementList ?? {};
  const hasActiveRefinements = Object.values(refinementList).some((values) => values.length > 0);
  const currentPage = typeof indexUiState.page === 'number' ? indexUiState.page : 0;
  const showPendingOverlay = !indexUiState.query && !hasActiveRefinements && currentPage === 0;
  const visiblePendingSermons = useMemo(
    () =>
      (pendingSermons ?? []).filter(
        (sermon) => sermon.status.audioStatus === sermonStatusType.PROCESSING || !visibleHitIds.has(sermon.id)
      ),
    [pendingSermons, visibleHitIds]
  );
  const visiblePendingIds = useMemo(() => new Set(visiblePendingSermons.map((sermon) => sermon.id)), [visiblePendingSermons]);
  const visibleAlgoliaHits = useMemo(
    () => normalizedHits.filter((sermon) => !visiblePendingIds.has(sermon.id)),
    [normalizedHits, visiblePendingIds]
  );
  const visibleAlgoliaHitIds = useMemo(
    () => visibleAlgoliaHits.map((sermon) => sermon.id),
    [visibleAlgoliaHits]
  );
  const liveVisibleSermonsById = useLiveVisibleSermons(visibleAlgoliaHitIds);
  const hydratedVisibleAlgoliaHits = useMemo(
    () => visibleAlgoliaHits.map((sermon) => liveVisibleSermonsById[sermon.id] ?? sermon),
    [liveVisibleSermonsById, visibleAlgoliaHits]
  );
  const hasVisibleHits = hydratedVisibleAlgoliaHits.length > 0;
  const hasVisiblePending = showPendingOverlay && visiblePendingSermons.length > 0;
  const isLoadingState = status === 'stalled' && !hasVisibleHits && !hasVisiblePending;
  const shouldRenderHits = hasVisibleHits || hasSettledResults || hasVisiblePending;

  useEffect(() => {
    const indexedPendingSermons = (pendingSermons ?? []).filter(
      (sermon) =>
        sermon.searchPending &&
        sermon.status.audioStatus !== sermonStatusType.PROCESSING &&
        visibleHitIds.has(sermon.id) &&
        !acknowledgedPendingIdsRef.current.has(sermon.id)
    );

    if (indexedPendingSermons.length === 0) {
      return;
    }

    indexedPendingSermons.forEach((sermon) => acknowledgedPendingIdsRef.current.add(sermon.id));

    void Promise.all(
      indexedPendingSermons.map(async (sermon) => {
        try {
          await updateDoc(doc(firestore, 'sermons', sermon.id), {
            searchPending: false,
            searchIndexedAtMillis: Date.now(),
            searchSyncError: deleteField(),
          });
        } catch (error) {
          console.error('Failed to acknowledge Algolia sync for sermon', sermon.id, error);
          acknowledgedPendingIdsRef.current.delete(sermon.id);
        }
      })
    );
  }, [pendingSermons, visibleHitIds]);

  return (
    <Box display="flex" justifyContent="start" flex={3} overflow="hidden" {...props}>
      <List
        sx={{
          maxWidth: '1200px',
          width: '100%',
          overflow: 'hidden',
          px: { xs: 0, sm: 1 },
          py: { xs: 0.5, sm: 1 },
        }}
      >
        {status === 'error' && (
          <Typography component="div">
            <Box fontWeight="bold" display="inline">
              Error: Algolia search errored please try again later
            </Box>
          </Typography>
        )}
        {isLoadingState &&
          [...Array(20)].map((_, i) => <SermonListCardSkeloten key={`sermonListCardSkeloten_${i}`} />)}
        {showPendingOverlay &&
          visiblePendingSermons.length > 0 &&
          visiblePendingSermons.map((sermon) => (
            <SermonListCard
              key={`pending-${sermon.id}`}
              sermon={sermon}
              playing={currentSermonId === sermon.id ? playing : false}
              remainingTimeComponent={
                <RemainingTimeComponent
                  playing={currentSermonId === sermon.id ? playing : false}
                  duration={sermon.durationSeconds}
                />
              }
              trackProgressComponent={
                <TrackProgressComponent
                  playing={currentSermonId === sermon.id ? playing : false}
                  duration={sermon.durationSeconds}
                />
              }
              audioPlayerCurrentSermonId={currentSermonId}
              audioPlayerSetCurrentSermon={setCurrentSermon}
              subscriptionOwnedByParent
              enableProcessingProgress
              enableSeriesRealtime={false}
            />
          ))}
        {shouldRenderHits &&
          hydratedVisibleAlgoliaHits.map((sermon) => (
            <SermonListCard
              key={sermon.id}
              sermon={sermon}
              playing={currentSermonId === sermon.id ? playing : false}
              remainingTimeComponent={
                <RemainingTimeComponent
                  playing={currentSermonId === sermon.id ? playing : false}
                  duration={sermon.durationSeconds}
                />
              }
              trackProgressComponent={
                <TrackProgressComponent
                  playing={currentSermonId === sermon.id ? playing : false}
                  duration={sermon.durationSeconds}
                />
              }
              audioPlayerCurrentSermonId={currentSermonId}
              audioPlayerSetCurrentSermon={setCurrentSermon}
              subscriptionOwnedByParent
              enableProcessingProgress={false}
              enableSeriesRealtime={false}
            />
          ))}
        {shouldRenderHits && hydratedVisibleAlgoliaHits.length === 0 && (!showPendingOverlay || visiblePendingSermons.length === 0) && (
          <Typography sx={{ px: { xs: 0.5, sm: 1 } }} color="text.secondary">
            No sermons found. Upload a sermon to get started.
          </Typography>
        )}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
