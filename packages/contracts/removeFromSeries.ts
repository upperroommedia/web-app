interface RemoveFromSeriesInputBase {
  mediaItemId: string;
  operationKey?: string;
}

export type RemoveFromSeriesInputType = RemoveFromSeriesInputBase & (
  | { firestoreSeriesId: string; seriesSubsplashId?: string }
  | { firestoreSeriesId?: never; seriesSubsplashId: string }
);

export interface RemoveFromSeriesOutputType {
  status: 'success' | 'error';
  message: string;
  mediaItemId: string;
}
