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
  const confirmedAlgoliaHits = algoliaHits
    .filter((sermon) => !resolvedLiveSermonIds.has(sermon.id) || Boolean(liveSermonsById[sermon.id]))
    .map((sermon) => liveSermonsById[sermon.id] ?? sermon);
  const confirmedAlgoliaHitsById = new Map(confirmedAlgoliaHits.map((sermon) => [sermon.id, sermon]));

  const confirmedVisibleHitIds = new Set(confirmedAlgoliaHits.map((sermon) => sermon.id));

  const visiblePendingSermons = showPendingOverlay
    ? pendingSermons.filter((sermon) => {
        if (!hasSettledResults) {
          return true;
        }

        const confirmedHit = confirmedAlgoliaHitsById.get(sermon.id);
        if (!confirmedHit) {
          return true;
        }

        return (confirmedHit.editedAtMillis ?? 0) < (sermon.editedAtMillis ?? 0);
      })
    : [];

  const visiblePendingIds = new Set(visiblePendingSermons.map((sermon) => sermon.id));

  return {
    confirmedVisibleHitIds,
    visiblePendingSermons,
    visibleAlgoliaHits: confirmedAlgoliaHits.filter((sermon) => !visiblePendingIds.has(sermon.id)),
    displayRows: [
      ...visiblePendingSermons.map((sermon) => ({
        sermon,
        enableProcessingProgress: sermon.status.audioStatus === sermonStatusType.PROCESSING,
      })),
      ...confirmedAlgoliaHits
        .filter((sermon) => !visiblePendingIds.has(sermon.id))
        .map((sermon) => ({
          sermon,
          enableProcessingProgress: sermon.status.audioStatus === sermonStatusType.PROCESSING,
        })),
    ],
  };
};
