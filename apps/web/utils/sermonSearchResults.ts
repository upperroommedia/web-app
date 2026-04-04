import { Sermon, sermonStatusType } from '../types/SermonTypes';

interface ReconcileAdminSermonSearchResultsInput {
  algoliaHits: Sermon[];
  pendingSermons: Sermon[];
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
  showPendingOverlay,
  hasSettledResults,
  liveSermonsById,
  resolvedLiveSermonIds,
}: ReconcileAdminSermonSearchResultsInput): ReconcileAdminSermonSearchResultsOutput => {
  const hydratedAlgoliaHits = algoliaHits
    .map((sermon) => liveSermonsById[sermon.id])
    .filter((sermon): sermon is Sermon => Boolean(sermon));
  const hydratedAlgoliaHitsById = new Map(hydratedAlgoliaHits.map((sermon) => [sermon.id, sermon]));

  const confirmedVisibleHitIds = new Set(
    algoliaHits
      .filter((sermon) => resolvedLiveSermonIds.has(sermon.id) && Boolean(liveSermonsById[sermon.id]))
      .map((sermon) => sermon.id)
  );

  const visiblePendingSermons = showPendingOverlay
    ? pendingSermons.filter((sermon) => {
        if (!hasSettledResults) {
          return true;
        }

        const hydratedHit = hydratedAlgoliaHitsById.get(sermon.id);
        if (!hydratedHit) {
          return true;
        }

        return (hydratedHit.editedAtMillis ?? 0) < (sermon.editedAtMillis ?? 0);
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
