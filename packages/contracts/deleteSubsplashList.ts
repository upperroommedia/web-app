export interface DeleteSubsplashListInputType {
  listId: string;
  operationKey?: string;
}

export interface DeleteSubsplashListBlockedOverflowPage {
  firestoreListId: string;
  subsplashId?: string;
  name: string;
  depth: number;
  count: number;
}

export interface DeleteSubsplashListBlockedDetails {
  reason: 'ROOT_HAS_OVERFLOW_PAGES';
  requestedListId: string;
  rootListId: string;
  rootName: string;
  logicalCount: number;
  totalPages: number;
  overflowPageCount: number;
  overflowPages: DeleteSubsplashListBlockedOverflowPage[];
}

export interface DeleteSubsplashListDeletedResult {
  status: 'deleted';
}

export interface DeleteSubsplashListBlockedResult {
  status: 'blocked';
  blocked: DeleteSubsplashListBlockedDetails;
}

export type DeleteSubsplashListOutputType = DeleteSubsplashListDeletedResult | DeleteSubsplashListBlockedResult;
