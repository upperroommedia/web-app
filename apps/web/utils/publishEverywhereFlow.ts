type StatusResult = {
  status: 'success' | 'error';
  error?: string;
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

  const listPromise = shouldPublishLists
    ? prepError || !mediaItemId
      ? Promise.resolve(createPrepErrorResult(prepError || 'Failed to prepare media item.') as TListResult)
      : publishLists(mediaItemId)
    : null;
  const seriesPromise = shouldPublishSeries
    ? prepError || !mediaItemId
      ? Promise.resolve(createPrepErrorResult(prepError || 'Failed to prepare media item.') as TSeriesResult)
      : publishSeries(mediaItemId)
    : null;

  const [listResult, seriesResult, soundCloudResult] = await Promise.all([
    listPromise ?? Promise.resolve<TListResult | null>(null),
    seriesPromise ?? Promise.resolve<TSeriesResult | null>(null),
    soundCloudPromise ?? Promise.resolve<TSoundCloudResult | null>(null),
  ]);

  return {
    listResult,
    seriesResult,
    soundCloudResult,
    ...(mediaItemId ? { mediaItemId } : {}),
  };
}
