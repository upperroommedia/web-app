export interface GetSubsplashUnpublishStrategyInput {
  hasSubsplashId: boolean;
  publishedListCount: number;
  listCountToUnpublish: number;
  seriesPublished: boolean;
  unpublishSeries: boolean;
  publishListCount: number;
  publishSeries: boolean;
}

export type SubsplashUnpublishStrategy = 'none' | 'remove_memberships' | 'delete_media';

export const getSubsplashUnpublishStrategy = (
  input: GetSubsplashUnpublishStrategyInput
): SubsplashUnpublishStrategy => {
  if (!input.hasSubsplashId) {
    return 'none';
  }

  const isRemovingAnySubsplashMembership = input.listCountToUnpublish > 0 || input.unpublishSeries;
  if (!isRemovingAnySubsplashMembership) {
    return 'none';
  }

  const remainingPublishedLists = Math.max(0, input.publishedListCount - input.listCountToUnpublish);
  const hasRemainingSeriesMembership = input.seriesPublished && !input.unpublishSeries;
  const hasNewSubsplashPublishes = input.publishListCount > 0 || input.publishSeries;

  if (remainingPublishedLists === 0 && !hasRemainingSeriesMembership && !hasNewSubsplashPublishes) {
    return 'delete_media';
  }

  return 'remove_memberships';
};
