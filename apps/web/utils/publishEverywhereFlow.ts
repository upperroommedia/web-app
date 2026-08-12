type StatusResult = {
  status: 'success' | 'error';
  error?: string;
  mediaItemId?: string;
};

type MediaItemResult = {
  mediaItemId: string;
};

export type PublishEverywhereFlowResult<
  TListResult extends StatusResult,
  TSeriesResult extends StatusResult,
  TSoundCloudResult extends StatusResult,
> = {
  listResult: TListResult | null;
  seriesResult: TSeriesResult | null;
  soundCloudResult: TSoundCloudResult | null;
  mediaItemId?: string;
};

export type PublishEverywhereFlowOptions<
  TListResult extends StatusResult,
  TSeriesResult extends StatusResult,
  TSoundCloudResult extends StatusResult,
> = {
  shouldPublishLists: boolean;
  shouldPublishSeries: boolean;
  shouldPublishSoundCloud: boolean;
  initialMediaItemId?: string;
  ensureMediaItem: () => Promise<MediaItemResult>;
  publishLists: (mediaItemId: string) => Promise<TListResult>;
  publishSeries: (mediaItemId: string) => Promise<TSeriesResult>;
  publishSoundCloud: () => Promise<TSoundCloudResult>;
  createPrepErrorResult: (error: string) => TListResult | TSeriesResult;
};

export async function runPublishEverywhereFlow<
  TListResult extends StatusResult,
  TSeriesResult extends StatusResult,
  TSoundCloudResult extends StatusResult,
>(
  options: PublishEverywhereFlowOptions<TListResult, TSeriesResult, TSoundCloudResult>
): Promise<PublishEverywhereFlowResult<TListResult, TSeriesResult, TSoundCloudResult>> {
  const {
    shouldPublishLists,
    shouldPublishSeries,
    shouldPublishSoundCloud,
    initialMediaItemId,
    ensureMediaItem,
    publishLists,
    publishSeries,
    publishSoundCloud,
    createPrepErrorResult,
  } = options;

  const soundCloudPromise = shouldPublishSoundCloud ? publishSoundCloud() : null;
  let mediaItemId = initialMediaItemId;
  let prepError: string | undefined;

  if ((shouldPublishLists || shouldPublishSeries) && !mediaItemId) {
    try {
      mediaItemId = (await ensureMediaItem()).mediaItemId;
    } catch (error: unknown) {
      prepError = error instanceof Error && error.message ? error.message : String(error);
    }
  }

  let listResult: TListResult | null = null;
  let seriesResult: TSeriesResult | null = null;

  // Lists and series both mutate the same Subsplash media item, so they must not
  // run in parallel or the second mutation can lose the media-item lock.
  if (shouldPublishLists) {
    listResult = prepError || !mediaItemId
      ? createPrepErrorResult(prepError || 'Failed to prepare media item.') as TListResult
      : await publishLists(mediaItemId);
    if (listResult?.status === 'success' && listResult.mediaItemId) {
      mediaItemId = listResult.mediaItemId;
    }
  }

  if (shouldPublishSeries) {
    seriesResult = prepError || !mediaItemId
      ? createPrepErrorResult(prepError || 'Failed to prepare media item.') as TSeriesResult
      : await publishSeries(mediaItemId);
  }

  const soundCloudResult = soundCloudPromise
    ? await soundCloudPromise
    : null;

  return {
    listResult,
    seriesResult,
    soundCloudResult,
    ...(mediaItemId ? { mediaItemId } : {}),
  };
}
