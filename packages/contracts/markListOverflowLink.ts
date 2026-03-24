export interface MarkListOverflowLinkInputType {
  rootListId: string;
  physicalFirestoreListId: string;
  rowId: string;
  clear?: boolean;
}

export interface MarkListOverflowLinkOutputType {
  status: 'success';
  rootListId: string;
  physicalFirestoreListId: string;
  linkedSubsplashListId?: string;
  linkedFirestoreListId?: string;
  overflowDepth?: number;
  cleared: boolean;
}
