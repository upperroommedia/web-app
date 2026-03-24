export interface DeleteSeriesInputType {
  firestoreId: string;
  operationKey?: string;
}

export interface DeleteSeriesOutputType {
  status: 'success' | 'error';
  remoteUnlinkAttempted: number;
  remoteUnlinkSucceeded: number;
  remoteUnlinkSkippedNotFound: number;
  remoteRemainingLinkedCount: number;
  localSeriesItemsDeleted: number;
  localSermonsUnlinked: number;
  error?: string;
}
