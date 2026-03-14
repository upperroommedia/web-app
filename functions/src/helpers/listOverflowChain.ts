import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { List } from '@upperroom/shared/types/List';
import { HttpsError } from 'firebase-functions/v2/https';
import type {
  GetListOverflowChainIssue,
  GetListOverflowChainNode,
  GetListOverflowChainOutputType,
} from '../../../packages/contracts/getListOverflowChain';

type StoredListData = List & {
  title?: string;
};

type StoredListRecord = {
  id: string;
  data: StoredListData;
};

const firestore = firebaseAdmin.firestore();

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const getListName = (record: StoredListRecord): string =>
  normalizeString(record.data.name) ?? normalizeString(record.data.title) ?? record.id;

const getCanonicalOverflowListName = (rootName: string): string => `More ${rootName} sermons`;

const getListCount = (record: StoredListRecord): number => {
  return typeof record.data.count === 'number' && Number.isFinite(record.data.count) ? record.data.count : 0;
};

const getStoredListRecordById = async (listId: string): Promise<StoredListRecord | null> => {
  const snapshot = await firestore.collection('lists').doc(listId).get();
  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    data: snapshot.data() as StoredListData,
  };
};

const getStoredListRecordsByField = async (field: string, value: string): Promise<StoredListRecord[]> => {
  const snapshot = await firestore.collection('lists').where(field, '==', value).limit(2).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data() as StoredListData,
  }));
};

const pushIssue = (
  issues: GetListOverflowChainIssue[],
  nextIssue: GetListOverflowChainIssue
): void => {
  const alreadyExists = issues.some((issue) => {
    return (
      issue.code === nextIssue.code &&
      issue.firestoreListId === nextIssue.firestoreListId &&
      issue.subsplashListId === nextIssue.subsplashListId
    );
  });

  if (!alreadyExists) {
    issues.push(nextIssue);
  }
};

const resolveRootRecord = async (
  startingRecord: StoredListRecord,
  issues: GetListOverflowChainIssue[]
): Promise<StoredListRecord> => {
  const explicitRootListId = normalizeString(startingRecord.data.rootListId);
  if (startingRecord.data.isRootList === true) {
    if (explicitRootListId && explicitRootListId !== startingRecord.id) {
      pushIssue(issues, {
        code: 'CHAIN_ROOT_METADATA_CONFLICT',
        severity: 'blocking',
        message: 'Root list metadata points to a different logical root.',
        firestoreListId: startingRecord.id,
      });
    }
    return startingRecord;
  }

  if (explicitRootListId && explicitRootListId !== startingRecord.id) {
    const explicitRootRecord = await getStoredListRecordById(explicitRootListId);
    if (explicitRootRecord) {
      return explicitRootRecord;
    }

    pushIssue(issues, {
      code: 'CHAIN_ROOT_METADATA_CONFLICT',
      severity: 'blocking',
      message: 'Explicit rootListId points to a missing Firestore list.',
      firestoreListId: startingRecord.id,
    });
  }

  const visitedListIds = new Set<string>();
  let currentRecord = startingRecord;

  while (true) {
    if (visitedListIds.has(currentRecord.id)) {
      pushIssue(issues, {
        code: 'CHAIN_CYCLE_DETECTED',
        severity: 'blocking',
        message: 'Cycle detected while resolving the logical root list.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
      return currentRecord;
    }

    visitedListIds.add(currentRecord.id);

    const currentSubsplashId = normalizeString(currentRecord.data.subsplashId);
    if (!currentSubsplashId) {
      return currentRecord;
    }

    const parentMatches = await getStoredListRecordsByField('moreSermonsRef', currentSubsplashId);
    if (parentMatches.length === 0) {
      return currentRecord;
    }

    if (parentMatches.length > 1) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Multiple parent lists reference the same overflow page.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentSubsplashId,
      });
    }

    currentRecord = parentMatches[0];
  }
};

const buildChainFromRoot = async (
  rootRecord: StoredListRecord,
  issues: GetListOverflowChainIssue[]
): Promise<GetListOverflowChainNode[]> => {
  const nodes: GetListOverflowChainNode[] = [];
  const visitedListIds = new Set<string>();
  const depthMap = new Map<number, string>();

  let currentRecord: StoredListRecord | null = rootRecord;
  let parentRecord: StoredListRecord | null = null;
  let inferredDepth = 0;

  while (currentRecord) {
    if (visitedListIds.has(currentRecord.id)) {
      pushIssue(issues, {
        code: 'CHAIN_CYCLE_DETECTED',
        severity: 'blocking',
        message: 'Cycle detected while traversing the overflow chain.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
      break;
    }

    visitedListIds.add(currentRecord.id);

    const explicitDepth = currentRecord.data.overflowDepth;
    const nodeDepth = typeof explicitDepth === 'number' ? explicitDepth : inferredDepth;

    if (typeof explicitDepth === 'number' && explicitDepth !== inferredDepth) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Explicit overflow depth does not match parent-child chain position.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    }

    if (depthMap.has(nodeDepth)) {
      pushIssue(issues, {
        code: 'CHAIN_DEPTH_COLLISION',
        severity: 'blocking',
        message: 'Multiple lists claim the same overflow depth.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    } else {
      depthMap.set(nodeDepth, currentRecord.id);
    }

    const rootName = getListName(rootRecord);
    const currentName = getListName(currentRecord);
    if (parentRecord && currentName !== getCanonicalOverflowListName(rootName)) {
      pushIssue(issues, {
        code: 'CHAIN_NAME_DRIFT',
        severity: 'warning',
        message: 'Overflow page name differs from the canonical root naming pattern.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    }

    const nextSubsplashListId = normalizeString(currentRecord.data.moreSermonsRef) ?? null;
    nodes.push({
      firestoreListId: currentRecord.id,
      subsplashId: normalizeString(currentRecord.data.subsplashId),
      name: currentName,
      depth: nodeDepth,
      count: getListCount(currentRecord),
      isRoot: !parentRecord,
      parentFirestoreListId: parentRecord?.id ?? null,
      nextSubsplashListId,
    });

    if (!nextSubsplashListId) {
      break;
    }

    if (nextSubsplashListId === normalizeString(currentRecord.data.subsplashId)) {
      pushIssue(issues, {
        code: 'CHAIN_SELF_LINK',
        severity: 'blocking',
        message: 'A list links to itself as its own overflow page.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
      break;
    }

    const nextMatches = await getStoredListRecordsByField('subsplashId', nextSubsplashListId);
    if (nextMatches.length === 0) {
      pushIssue(issues, {
        code: 'CHAIN_MISSING_LINK_TARGET',
        severity: 'blocking',
        message: 'A list points to an overflow page that is missing from Firestore.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
      break;
    }

    if (nextMatches.length > 1) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Multiple Firestore lists share the same Subsplash overflow page id.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
    }

    const nextRecord = nextMatches[0];
    const nextExplicitRootListId = normalizeString(nextRecord.data.rootListId);
    if (nextExplicitRootListId && nextExplicitRootListId !== rootRecord.id) {
      pushIssue(issues, {
        code: 'CHAIN_ROOT_METADATA_CONFLICT',
        severity: 'blocking',
        message: 'Overflow page metadata points to a different logical root.',
        firestoreListId: nextRecord.id,
        subsplashListId: nextRecord.data.subsplashId,
      });
    }

    parentRecord = currentRecord;
    currentRecord = nextRecord;
    inferredDepth += 1;
  }

  return nodes;
};

export const getOverflowChainState = async (
  listId: string
): Promise<GetListOverflowChainOutputType> => {
  const normalizedListId = normalizeString(listId);
  if (!normalizedListId) {
    throw new HttpsError('invalid-argument', 'listId is required.');
  }

  const requestedRecord = await getStoredListRecordById(normalizedListId);
  if (!requestedRecord) {
    throw new HttpsError('not-found', `List ${normalizedListId} not found.`);
  }

  const issues: GetListOverflowChainIssue[] = [];
  const rootRecord = await resolveRootRecord(requestedRecord, issues);
  const nodes = await buildChainFromRoot(rootRecord, issues);

  const computedLogicalCount = nodes.reduce((sum, node) => sum + node.count, 0);
  const rootLogicalCount =
    typeof rootRecord.data.logicalCount === 'number' ? rootRecord.data.logicalCount : undefined;

  return {
    requestedListId: normalizedListId,
    rootListId: rootRecord.id,
    redirectListId: rootRecord.id,
    logicalCount: rootLogicalCount ?? computedLogicalCount,
    canMutate: !issues.some((issue) => issue.severity === 'blocking'),
    nodes,
    issues,
  };
};

export { getCanonicalOverflowListName };
