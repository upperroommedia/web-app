export interface GetListOverflowChainInputType {
  listId: string;
}

export type GetListOverflowChainIssueCode =
  | 'CHAIN_CYCLE_DETECTED'
  | 'CHAIN_DEPTH_COLLISION'
  | 'CHAIN_NAME_DRIFT'
  | 'CHAIN_MISSING_LINK_TARGET'
  | 'CHAIN_PARENT_CHILD_MISMATCH'
  | 'CHAIN_ROOT_METADATA_CONFLICT'
  | 'CHAIN_SELF_LINK';

export type GetListOverflowChainIssueSeverity = 'warning' | 'blocking';

export interface GetListOverflowChainIssue {
  code: GetListOverflowChainIssueCode;
  severity: GetListOverflowChainIssueSeverity;
  message: string;
  firestoreListId?: string;
  subsplashListId?: string;
}

export interface GetListOverflowChainNode {
  firestoreListId: string;
  subsplashId?: string;
  name: string;
  depth: number;
  count: number;
  isRoot: boolean;
  parentFirestoreListId: string | null;
  nextSubsplashListId: string | null;
}

export interface GetListOverflowChainOutputType {
  requestedListId: string;
  rootListId: string;
  redirectListId: string;
  logicalCount: number;
  canMutate: boolean;
  nodes: GetListOverflowChainNode[];
  issues: GetListOverflowChainIssue[];
}
