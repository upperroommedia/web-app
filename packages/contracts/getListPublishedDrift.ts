export interface GetListPublishedDriftInputType {
  listId: string;
}

export type PublishedListDriftIssueCode =
  | 'IN_SYNC'
  | 'ORDER_MISMATCH'
  | 'MEMBERSHIP_MISMATCH'
  | 'REMOTE_ONLY_MATCHED'
  | 'REMOTE_ONLY_AMBIGUOUS_MATCH'
  | 'REMOTE_ONLY_UNMATCHED'
  | 'LOCAL_ONLY_PUBLISHED'
  | 'CONTINUATION_ROW_INVALID'
  | 'CHAIN_STRUCTURE_INVALID'
  | 'REMOTE_ONLY_UNSUPPORTED_TYPE';

export type PublishedListDriftIssueSeverity = 'info' | 'warning' | 'blocking';

export interface PublishedListPlacement {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  position: number;
  listItemId?: string;
}

export interface PublishedListDriftIssue {
  code: PublishedListDriftIssueCode;
  severity: PublishedListDriftIssueSeverity;
  message: string;
  sermonId?: string;
  mediaItemId?: string;
  mediaType?: string;
  firestoreListId?: string;
  subsplashListId?: string;
  localPosition?: number;
  remotePosition?: number;
}

export interface PublishedListDriftLocalItem {
  sermonId: string;
  mediaItemId?: string;
  title: string;
  logicalPosition: number;
  published: boolean;
}

export interface PublishedListDriftRemoteItem {
  mediaItemId: string;
  mediaType: string;
  title?: string;
  matchedSermonId?: string;
  placement: PublishedListPlacement;
}

export interface GetListPublishedDriftOutputType {
  requestedListId: string;
  rootListId: string;
  inSync: boolean;
  canReorder: boolean;
  canOverflowPublish: boolean;
  canDelete: true;
  canRemove: true;
  issues: PublishedListDriftIssue[];
  localPublishedItems: PublishedListDriftLocalItem[];
  remotePublishedItems: PublishedListDriftRemoteItem[];
}
