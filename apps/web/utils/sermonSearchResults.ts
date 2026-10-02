import { Sermon, sermonStatusType } from '../types/SermonTypes';

interface ReconcileAdminSermonSearchResultsInput {
  algoliaHits: Sermon[];
  pendingSermons: Sermon[];
  pendingSermonsServerConfirmed: boolean;
  showPendingOverlay: boolean;
  hasSettledResults: boolean;
  liveSermonsById: Record<string, Sermon>;
  resolvedLiveSermonIds: Set<string>;
}

interface ReconcileAdminSermonSearchResultsOutput {
  confirmedVisibleHitIds: Set<string>;
  visiblePendingSermons: Sermon[];
  visibleAlgoliaHits: Sermon[];
  displayRows: Array<{
    sermon: Sermon;
    enableProcessingProgress: boolean;
  }>;
}

export const reconcileAdminSermonSearchResults = ({
  algoliaHits,
  pendingSermons,
  pendingSermonsServerConfirmed,
  showPendingOverlay,
  hasSettledResults,
  liveSermonsById,
  resolvedLiveSermonIds,
}: ReconcileAdminSermonSearchResultsInput): ReconcileAdminSermonSearchResultsOutput => {
  // Firestore may emit an old cached PROCESSING value before its server snapshot.
  // Only server-resolved documents can supply an upload status for indexed hits.
  const hydratedAlgoliaHits = algoliaHits
    .map((sermon) => (resolvedLiveSermonIds.has(sermon.id) ? liveSermonsById[sermon.id] : undefined))
    .filter((sermon): sermon is Sermon => Boolean(sermon));
  const hydratedAlgoliaHitsById = new Map(hydratedAlgoliaHits.map((sermon) => [sermon.id, sermon]));
  const algoliaHitsById = new Map(algoliaHits.map((sermon) => [sermon.id, sermon]));

  const confirmedVisibleHitIds = new Set(
    algoliaHits
      .filter((sermon) => resolvedLiveSermonIds.has(sermon.id) && Boolean(liveSermonsById[sermon.id]))
      .map((sermon) => sermon.id)
  );

  const visiblePendingSermons =
    showPendingOverlay && pendingSermonsServerConfirmed
      ? pendingSermons
          .map((sermon) => (resolvedLiveSermonIds.has(sermon.id) ? liveSermonsById[sermon.id] : sermon))
          .filter((sermon): sermon is Sermon => Boolean(sermon))
          .filter((sermon) => {
            if (!hasSettledResults) {
              return true;
            }

            const hydratedHit = hydratedAlgoliaHitsById.get(sermon.id);
            if (!hydratedHit) {
              return true;
            }

            return (algoliaHitsById.get(sermon.id)?.editedAtMillis ?? 0) < (sermon.editedAtMillis ?? 0);
          })
      : [];

  const visiblePendingIds = new Set(visiblePendingSermons.map((sermon) => sermon.id));

  return {
    confirmedVisibleHitIds,
    visiblePendingSermons,
    visibleAlgoliaHits: hydratedAlgoliaHits.filter((sermon) => !visiblePendingIds.has(sermon.id)),
    displayRows: [
      ...visiblePendingSermons.map((sermon) => ({
        sermon,
        enableProcessingProgress: sermon.status.audioStatus === sermonStatusType.PROCESSING,
      })),
      ...hydratedAlgoliaHits
        .filter((sermon) => !visiblePendingIds.has(sermon.id))
        .map((sermon) => ({
          sermon,
          enableProcessingProgress: sermon.status.audioStatus === sermonStatusType.PROCESSING,
        })),
    ],
  };
};
