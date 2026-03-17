export interface DeleteSubsplashListInputType {
  listId: string;
  operationKey?: string;
}

export interface DeleteSubsplashListDeletedResult {
  status: 'deleted';
  deletedFirestoreListIds: string[];
  deletedSubsplashListIds: string[];
  rootListId: string;
  requestedListId: string;
}
export type DeleteSubsplashListOutputType = DeleteSubsplashListDeletedResult;
