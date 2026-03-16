export type ResolveListPublishedDriftStrategy = 'FIREBASE_FROM_SUBSPLASH' | 'IGNORE';

export interface ResolveListPublishedDriftInputType {
  listId: string;
  strategy: ResolveListPublishedDriftStrategy;
}

export interface ResolveListPublishedDriftOutputType {
  status: 'success' | 'ignored';
  rootListId: string;
  updatedSermonIds: string[];
  importedSermonIds: string[];
  untouchedUnpublishedSermonIds: string[];
}
