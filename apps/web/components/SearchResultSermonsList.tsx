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
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
} from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { normalizeAlgoliaSermonHit, type AlgoliaSermonHit } from '../utils/algolia/searchRecords';
import {
  getPendingSermonsReadyForAcknowledgement,
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

const useLiveVisibleSermons = (sermonIds: string[], enabled: boolean) => {
  const [state, setState] = useState<{
    hydratedKey: string;
    liveSermonsById: Record<string, Sermon>;
    resolvedIds: Set<string>;
  }>({
    hydratedKey: '',
    liveSermonsById: {},
    resolvedIds: new Set<string>(),
  });
  const visibleIdsKey = useMemo(() => sermonIds.join(','), [sermonIds]);

  useEffect(() => {
    if (!enabled || sermonIds.length === 0) {
      return;
    }

    let cancelled = false;
    const idChunks = chunkIds(sermonIds, FIRESTORE_IN_QUERY_LIMIT);
    const hydrateVisibleHits = async () => {
      const nextLiveSermonsById: Record<string, Sermon> = {};
      const nextResolvedIds = new Set<string>();

      await Promise.all(
        idChunks.map(async (idChunk) => {
          const sermonsQuery = query(
            collection(firestore, 'sermons').withConverter(sermonConverter),
            where(documentId(), 'in', idChunk)
          );
          const snapshot = await getDocs(sermonsQuery);

          const nextChunkRecords: Record<string, Sermon> = {};
          snapshot.docs.forEach((docSnapshot) => {
            nextChunkRecords[docSnapshot.id] = docSnapshot.data();
          });

          idChunk.forEach((id) => nextResolvedIds.add(id));
          Object.assign(nextLiveSermonsById, nextChunkRecords);
        })
      );

      if (cancelled) {
        return;
      }

      setState({
        hydratedKey: visibleIdsKey,
        liveSermonsById: nextLiveSermonsById,
        resolvedIds: nextResolvedIds,
      });
    };

    hydrateVisibleHits().catch((error) => {
      if (!cancelled) {
        console.error('Failed to hydrate visible sermon hits from Firestore', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, sermonIds, visibleIdsKey]);

  return useMemo(() => {
    if (!enabled || sermonIds.length === 0) {
      return {
        liveSermonsById: {},
        resolvedIds: new Set<string>(),
        liveHitHydrationSettled: true,
      };
    }

    const visibleIdSet = new Set(sermonIds);
    return {
      liveSermonsById: Object.fromEntries(
        Object.entries(state.liveSermonsById).filter(([sermonId]) => visibleIdSet.has(sermonId))
      ),
      resolvedIds: new Set([...state.resolvedIds].filter((sermonId) => visibleIdSet.has(sermonId))),
      liveHitHydrationSettled:
        state.hydratedKey === visibleIdsKey && sermonIds.every((sermonId) => state.resolvedIds.has(sermonId)),
    };
  }, [enabled, state, sermonIds, visibleIdsKey]);
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
  const visibleHitIds = useMemo(() => normalizedHits.map((hit) => hit.id), [normalizedHits]);
  const refinementList = (indexUiState as { refinementList?: Record<string, string[]> }).refinementList ?? {};
  const hasActiveRefinements = Object.values(refinementList).some((values) => values.length > 0);
  const currentPage = typeof indexUiState.page === 'number' ? indexUiState.page : 0;
  const showPendingOverlay = !indexUiState.query && !hasActiveRefinements && currentPage === 0;
  const hydrateVisibleHits = showPendingOverlay && visibleHitIds.length > 0;
  const { liveSermonsById, resolvedIds: resolvedLiveSermonIds, liveHitHydrationSettled } = useLiveVisibleSermons(
    visibleHitIds,
    hydrateVisibleHits
  );
  const { confirmedVisibleHitIds, visiblePendingSermons, visibleAlgoliaHits, displayRows } = useMemo(
    () =>
      reconcileAdminSermonSearchResults({
        algoliaHits: normalizedHits,
        pendingSermons: pendingSermons ?? [],
        showPendingOverlay,
        liveHitHydrationSettled,
        hasSettledResults,
        liveSermonsById,
        resolvedLiveSermonIds,
      }),
    [
      hasSettledResults,
      liveHitHydrationSettled,
      liveSermonsById,
      normalizedHits,
      pendingSermons,
      resolvedLiveSermonIds,
      showPendingOverlay,
    ]
  );
  const hasVisibleHits = visibleAlgoliaHits.length > 0;
  const hasVisiblePending = showPendingOverlay && visiblePendingSermons.length > 0;
  const isHydratingVisibleHits = hydrateVisibleHits && !liveHitHydrationSettled && !hasVisiblePending;
  const isLoadingState = (status === 'stalled' || isHydratingVisibleHits) && !hasVisibleHits && !hasVisiblePending;
  const shouldRenderHits = hasVisibleHits || hasSettledResults || hasVisiblePending;

  useEffect(() => {
    const indexedPendingSermons = getPendingSermonsReadyForAcknowledgement({
      pendingSermons: pendingSermons ?? [],
      hasSettledResults,
      confirmedVisibleHitIds,
    }).filter((sermon) => !acknowledgedPendingIdsRef.current.has(sermon.id));

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
  }, [confirmedVisibleHitIds, hasSettledResults, pendingSermons]);

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
              enableSeriesRealtime={false}
            />
          ))}
        {shouldRenderHits
          && !isHydratingVisibleHits
          && visibleAlgoliaHits.length === 0
          && (!showPendingOverlay || visiblePendingSermons.length === 0) && (
          <Typography sx={{ px: { xs: 0.5, sm: 1 } }} color="text.secondary">
            No sermons found. Upload a sermon to get started.
          </Typography>
          )}
      </List>
    </Box>
  );
};

export default SearchResultSermonList;
