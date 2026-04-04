import { useEffect, useMemo, useState } from 'react';
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
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { normalizeAlgoliaSermonHit, type AlgoliaSermonHit } from '../utils/algolia/searchRecords';
import {
  reconcileAdminSermonSearchResults,
} from '../utils/sermonSearchResults';

const FIRESTORE_IN_QUERY_LIMIT = 10;

const chunkIds = (ids: string[], chunkSize: number): string[][] => {
  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }

  return chunks;
};

const useLiveVisibleSermons = (sermonIds: string[]) => {
  const [state, setState] = useState<{
    liveSermonsById: Record<string, Sermon>;
    resolvedIds: Set<string>;
  }>({
    liveSermonsById: {},
    resolvedIds: new Set<string>(),
  });

  useEffect(() => {
    if (sermonIds.length === 0) {
      setState({
        liveSermonsById: {},
        resolvedIds: new Set<string>(),
      });
      return;
    }

    setState({
      liveSermonsById: {},
      resolvedIds: new Set<string>(),
    });

    const chunkSnapshots = new Map<number, { ids: string[]; records: Record<string, Sermon>; resolved: boolean }>();
    const updateState = () => {
      const nextLiveSermonsById: Record<string, Sermon> = {};
      const nextResolvedIds = new Set<string>();

      chunkSnapshots.forEach(({ ids, records, resolved }) => {
        if (resolved) {
          ids.forEach((id) => nextResolvedIds.add(id));
        }
        Object.assign(nextLiveSermonsById, records);
      });

      setState({
        liveSermonsById: nextLiveSermonsById,
        resolvedIds: nextResolvedIds,
      });
    };

    const unsubscribeCallbacks = chunkIds(sermonIds, FIRESTORE_IN_QUERY_LIMIT).map((idChunk, chunkIndex) => {
      const sermonsQuery = query(
        collection(firestore, 'sermons').withConverter(sermonConverter),
        where(documentId(), 'in', idChunk)
      );

      return onSnapshot(
        sermonsQuery,
        { includeMetadataChanges: true },
        (snapshot) => {
          const nextChunkRecords: Record<string, Sermon> = {};
          snapshot.docs.forEach((docSnapshot) => {
            nextChunkRecords[docSnapshot.id] = docSnapshot.data();
          });
          chunkSnapshots.set(chunkIndex, {
            ids: idChunk,
            records: nextChunkRecords,
            resolved: !snapshot.metadata.fromCache,
          });
          updateState();
        },
        (error) => {
          console.error('Failed to hydrate visible sermon hits from Firestore', error);
        }
      );
    });

    return () => {
      unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe());
    };
  }, [sermonIds]);

  return useMemo(() => {
    if (sermonIds.length === 0) {
      return {
        liveSermonsById: {},
        resolvedIds: new Set<string>(),
      };
    }

    const visibleIdSet = new Set(sermonIds);
    return {
      liveSermonsById: Object.fromEntries(
        Object.entries(state.liveSermonsById).filter(([sermonId]) => visibleIdSet.has(sermonId))
      ),
      resolvedIds: new Set([...state.resolvedIds].filter((sermonId) => visibleIdSet.has(sermonId))),
    };
  }, [state, sermonIds]);
};

interface SearchResultSermonListProps extends BoxProps {
  hiddenSermonIds?: string[];
}

const SearchResultSermonList = ({ hiddenSermonIds = [], ...props }: SearchResultSermonListProps) => {
  const { hits } = useHits();
  const { status, results, indexUiState } = useInstantSearch();
  const { currentSermonId, setCurrentSermon } = useAudioPlayer();
  const playing = useMediaState('playing');
  const hasSettledResults = !results.__isArtificial && status === 'idle';
  const pendingSermonsQuery = useMemo(
    () =>
      query(
        collection(firestore, 'sermons').withConverter(sermonConverter),
        where('searchPending', '==', true),
        orderBy('editedAtMillis', 'desc'),
        limit(20)
      ),
    []
  );
  const [pendingSermons] = useCollectionData(pendingSermonsQuery);
  const hiddenSermonIdSet = useMemo(() => new Set(hiddenSermonIds), [hiddenSermonIds]);

  const normalizedHits = useMemo(
    () =>
      hits
        .map((hit) => normalizeAlgoliaSermonHit(hit as AlgoliaSermonHit))
        .filter((hit) => !hiddenSermonIdSet.has(hit.id)),
    [hiddenSermonIdSet, hits]
  );
  const visibleHitIds = useMemo(() => normalizedHits.map((hit) => hit.id), [normalizedHits]);
  const refinementList = (indexUiState as { refinementList?: Record<string, string[]> }).refinementList ?? {};
  const hasActiveRefinements = Object.values(refinementList).some((values) => values.length > 0);
  const currentPage = typeof indexUiState.page === 'number' ? indexUiState.page : 0;
  const showPendingOverlay = !indexUiState.query && !hasActiveRefinements && currentPage === 0;
  const { liveSermonsById, resolvedIds: resolvedLiveSermonIds } = useLiveVisibleSermons(visibleHitIds);
  const unresolvedVisibleHitIds = useMemo(
    () =>
      visibleHitIds.filter((sermonId) => !liveSermonsById[sermonId] && !resolvedLiveSermonIds.has(sermonId)),
    [liveSermonsById, resolvedLiveSermonIds, visibleHitIds]
  );
  const unresolvedVisibleHitCount = unresolvedVisibleHitIds.length;
  const hasUnresolvedVisibleHits = useMemo(
    () => visibleHitIds.some((sermonId) => !resolvedLiveSermonIds.has(sermonId)),
    [resolvedLiveSermonIds, visibleHitIds]
  );
  const { visiblePendingSermons, visibleAlgoliaHits, displayRows } = useMemo(
    () =>
      reconcileAdminSermonSearchResults({
        algoliaHits: normalizedHits,
        pendingSermons: (pendingSermons ?? []).filter((sermon) => !hiddenSermonIdSet.has(sermon.id)),
        showPendingOverlay,
        hasSettledResults,
        liveSermonsById,
        resolvedLiveSermonIds,
      }),
    [
      hasSettledResults,
      hiddenSermonIdSet,
      liveSermonsById,
      normalizedHits,
      pendingSermons,
      resolvedLiveSermonIds,
      showPendingOverlay,
    ]
  );
  const hasVisibleHits = visibleAlgoliaHits.length > 0;
  const hasVisiblePending = showPendingOverlay && visiblePendingSermons.length > 0;
  const isHydratingVisibleHits = hasSettledResults && visibleHitIds.length > 0 && hasUnresolvedVisibleHits;
  const isLoadingState = status === 'stalled' && !hasVisibleHits && !hasVisiblePending && unresolvedVisibleHitCount === 0;
  const shouldRenderHits = hasVisibleHits || hasSettledResults || hasVisiblePending;
  const shouldShowEmptyState =
    shouldRenderHits &&
    !isHydratingVisibleHits &&
    visibleAlgoliaHits.length === 0 &&
    (!showPendingOverlay || visiblePendingSermons.length === 0);

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
        {shouldRenderHits &&
          displayRows.map(({ sermon, enableProcessingProgress }) => (
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
              enableProcessingProgress={enableProcessingProgress}
            />
          ))}
        {shouldRenderHits &&
          unresolvedVisibleHitIds.map((sermonId) => <SermonListCardSkeloten key={`hydrating-sermon-${sermonId}`} />)}
        {shouldShowEmptyState && (
          <Typography sx={{ px: { xs: 0.5, sm: 1 } }} color="text.secondary">
            No sermons found. Upload a sermon to get started.
          </Typography>
        )}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
