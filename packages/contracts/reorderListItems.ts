export interface ListItemOrderEntry {
  rowId?: string;
  mediaItemId?: string;
  position: number;
}

export interface ReorderListItemsInputType {
  rootListId: string;
  logicalItemOrder: ListItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderListItemsAssignment {
  rowId?: string;
  mediaItemId?: string;
  matchedSermonId?: string;
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  position: number;
}

export interface ReorderListItemsOutputType {
  status: 'success' | 'error';
  message: string;
  rootListId: string;
  subsplashListId?: string;
  assignments: ReorderListItemsAssignment[];
}
