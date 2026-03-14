export interface ListItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderListItemsInputType {
  firestoreListId: string;
  itemOrder: ListItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderListItemsOutputType {
  status: 'success' | 'error';
  message: string;
  firestoreListId: string;
  subsplashListId?: string;
}
