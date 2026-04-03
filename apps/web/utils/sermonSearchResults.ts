import { Sermon, sermonStatusType } from '../types/SermonTypes';

interface ReconcileAdminSermonSearchResultsInput {
  algoliaHits: Sermon[];
  pendingSermons: Sermon[];
  showPendingOverlay: boolean;
  liveHitHydrationSettled: boolean;
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

interface PendingSermonsReadyForAcknowledgementInput {
  pendingSermons: Sermon[];
  hasSettledResults: boolean;
  confirmedVisibleHitIds: Set<string>;
}

export const reconcileAdminSermonSearchResults = ({
  algoliaHits,
  pendingSermons,
  showPendingOverlay,
  liveHitHydrationSettled,
  hasSettledResults,
  liveSermonsById,
  resolvedLiveSermonIds,
}: ReconcileAdminSermonSearchResultsInput): ReconcileAdminSermonSearchResultsOutput => {
  const confirmedAlgoliaHits = (!showPendingOverlay || liveHitHydrationSettled)
    ? algoliaHits
      .filter((sermon) => !resolvedLiveSermonIds.has(sermon.id) || Boolean(liveSermonsById[sermon.id]))
      .map((sermon) => liveSermonsById[sermon.id] ?? sermon)
    : [];

  const confirmedVisibleHitIds = new Set(confirmedAlgoliaHits.map((sermon) => sermon.id));
  const visibleHitIdsForPendingDedup = hasSettledResults ? confirmedVisibleHitIds : new Set<string>();

  const visiblePendingSermons = showPendingOverlay
    ? pendingSermons.filter(
        (sermon) =>
          sermon.status.audioStatus === sermonStatusType.PROCESSING || !visibleHitIdsForPendingDedup.has(sermon.id)
      )
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

export const getPendingSermonsReadyForAcknowledgement = ({
  pendingSermons,
  hasSettledResults,
  confirmedVisibleHitIds,
}: PendingSermonsReadyForAcknowledgementInput): Sermon[] => {
  if (!hasSettledResults) {
    return [];
  }

  return pendingSermons.filter(
    (sermon) =>
      sermon.searchPending &&
      sermon.status.audioStatus !== sermonStatusType.PROCESSING &&
      confirmedVisibleHitIds.has(sermon.id)
  );
};
