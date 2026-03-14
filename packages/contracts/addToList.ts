import { SubsplashMediaItem } from './types/Subsplash';

export interface AddtoListInputType {
  destinationListIds: string[];
  mediaItem: SubsplashMediaItem;
  maxListSize?: number;
  operationKey?: string;
}

type AddToListOutputItem =
  | { listId: string; status: 'success'; listItemId?: string }
  | { listId: string; status: 'error'; error: string; errorCode?: string; errorDetails?: unknown };

export type AddToListOutputType = AddToListOutputItem[];
