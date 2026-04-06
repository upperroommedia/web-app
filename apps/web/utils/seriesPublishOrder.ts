export interface SeriesPublishOrderItemInput {
  sermonId: string;
  publishedToSubsplash?: boolean;
  sermonSubsplashId?: string;
  position?: number;
}

export interface SeriesPublishedOrderItem {
  sermonId: string;
  mediaItemId: string;
  position: number;
}

const normalizeMediaItemId = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getNextSeriesPosition = (seriesItems: SeriesPublishOrderItemInput[]): number => {
  const highestPosition = seriesItems.reduce((currentHighest, item) => {
    return typeof item.position === 'number' && item.position > currentHighest ? item.position : currentHighest;
  }, 0);

  return highestPosition + 1;
};

export const buildPublishedSeriesOrder = (
  seriesItems: SeriesPublishOrderItemInput[],
  newlyPublishedSermonId: string,
  newlyPublishedMediaItemId: string,
  pendingPosition?: number
): SeriesPublishedOrderItem[] => {
  const orderedItems = seriesItems.map((item) => ({
    sermonId: item.sermonId,
    isPublished: item.sermonId === newlyPublishedSermonId ? true : item.publishedToSubsplash === true,
    mediaItemId:
      item.sermonId === newlyPublishedSermonId
        ? newlyPublishedMediaItemId
        : normalizeMediaItemId(item.sermonSubsplashId),
    position: typeof item.position === 'number' ? item.position : 0,
  }));

  if (!orderedItems.some((item) => item.sermonId === newlyPublishedSermonId)) {
    if (typeof pendingPosition !== 'number') {
      throw new Error('Series item is missing from Firestore order. Refresh and try again.');
    }

    orderedItems.push({
      sermonId: newlyPublishedSermonId,
      isPublished: true,
      mediaItemId: newlyPublishedMediaItemId,
      position: pendingPosition,
    });
  }

  orderedItems.sort((left, right) => right.position - left.position);

  const publishedItems = orderedItems.filter((item) => item.isPublished);
  const missingMediaId = publishedItems.find((item) => !item.mediaItemId);
  if (missingMediaId) {
    throw new Error(`Published series item ${missingMediaId.sermonId} is missing a Subsplash media ID.`);
  }

  return publishedItems.map((item) => ({
    sermonId: item.sermonId,
    mediaItemId: item.mediaItemId as string,
    position: item.position,
  }));
};
