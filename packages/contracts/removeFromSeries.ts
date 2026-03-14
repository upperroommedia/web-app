export interface RemoveFromSeriesInputType {
  mediaItemId: string;
  operationKey?: string;
}

export interface RemoveFromSeriesOutputType {
  status: 'success' | 'error';
  message: string;
  mediaItemId: string;
}
