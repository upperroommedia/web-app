export interface ItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderSeriesItemsInputType {
  firestoreSeriesId: string;
  itemOrder: ItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderSeriesItemsOutputType {
  status: 'success' | 'error';
  message: string;
  firestoreSeriesId: string;
  subsplashSeriesId?: string;
}
