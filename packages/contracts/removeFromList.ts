export interface RemoveFromListInputType {
  listIds: string[];
  listItemIds: string[];
  itemIds: string[];
  itemTypes: string[];
  sermonIds?: string[];
  operationKey?: string;
}

type RemoveFromListOutputItem =
  | { listId: string; status: 'success'; listItemId: string; itemNotFound?: boolean }
  | { listId: string; status: 'error'; error: string; errorCode?: string; errorDetails?: unknown };

export type RemoveFromListOutputType = RemoveFromListOutputItem[];
