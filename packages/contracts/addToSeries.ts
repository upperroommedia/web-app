export interface AddToSeriesInputType {
  seriesSubsplashId: string;
  mediaItemId: string;
  position?: number;
  operationKey?: string;
}

export interface AddToSeriesOutputType {
  status: 'success' | 'error';
  mediaItemId?: string;
  confirmedSeriesId?: string | null;
  position?: number | null;
  error?: string;
}
