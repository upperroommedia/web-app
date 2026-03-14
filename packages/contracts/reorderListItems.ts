export interface ListItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderListItemsInputType {
  rootListId: string;
  logicalItemOrder: ListItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderListItemsAssignment {
  mediaItemId: string;
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
