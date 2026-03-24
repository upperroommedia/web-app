import axios, { isAxiosError } from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { createAxiosConfig, authenticateSubsplash } from '../subsplashUtils';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';
import { getOverflowChainState } from './listOverflowChain';
import { listDebugLog, summarizeOverflowNodes } from './listDebugLogger';

const firestore = firebaseAdmin.firestore();

const deleteSubsplashListIgnoringNotFound = async (subsplashListId: string, token: string): Promise<void> => {
  const url = `https://core.subsplash.com/builder/v1/lists/${subsplashListId}`;
  const config = createAxiosConfig(url, token, 'DELETE');

  try {
    await axios(config);
  } catch (error) {
    if (isAxiosError(error)) {
      const responseCode = error.response?.data?.errors?.[0]?.code;
      if (error.response?.status === 404 || responseCode === 'resource_not_found') {
        logger.log('deleteLogicalListChain.remoteDelete.notFound', { subsplashListId });
        return;
      }
    }

    throw error;
  }
};

export interface DeleteLogicalListChainResult {
  requestedListId: string;
  rootListId: string;
  deletedFirestoreListIds: string[];
  deletedSubsplashListIds: string[];
  rootSubsplashListId?: string;
}

export const deleteLogicalListChain = async ({
  listId,
  operationKey,
  token: providedToken,
}: {
  listId: string;
  operationKey?: string;
  token?: string;
}): Promise<DeleteLogicalListChainResult> => {
  const chainState = await getOverflowChainState(listId);
  const orderedNodes = [...chainState.nodes].sort((left, right) => right.depth - left.depth);
  const deletedFirestoreListIds = orderedNodes.map((node) => node.firestoreListId);
  const deletedSubsplashListIds = orderedNodes.flatMap((node) => (node.subsplashId ? [node.subsplashId] : []));
  const rootSubsplashListId = chainState.nodes[0]?.subsplashId;

  listDebugLog('deleteLogicalListChain.start', {
    requestedListId: listId,
    rootListId: chainState.rootListId,
    nodes: summarizeOverflowNodes(chainState.nodes),
  });

  const remoteDeleteIds = Array.from(new Set(deletedSubsplashListIds));
  if (remoteDeleteIds.length > 0) {
    const token = providedToken ?? await authenticateSubsplash();
    await withSubsplashLocks(
      remoteDeleteIds.map((subsplashListId) => `list:${subsplashListId}`),
      async () => {
        for (const subsplashListId of remoteDeleteIds) {
          listDebugLog('deleteLogicalListChain.remoteDelete', {
            requestedListId: listId,
            subsplashListId,
          });
          await deleteSubsplashListIgnoringNotFound(subsplashListId, token);
        }
      },
      {
        ...(operationKey ? { operationKey } : {}),
      }
    );
  }

  for (const firestoreListId of deletedFirestoreListIds) {
    listDebugLog('deleteLogicalListChain.firestoreDelete', {
      requestedListId: listId,
      firestoreListId,
    });
    await firestore.recursiveDelete(firestore.collection('lists').doc(firestoreListId));
  }

  const result: DeleteLogicalListChainResult = {
    requestedListId: listId,
    rootListId: chainState.rootListId,
    deletedFirestoreListIds,
    deletedSubsplashListIds,
    ...(rootSubsplashListId ? { rootSubsplashListId } : {}),
  };

  listDebugLog('deleteLogicalListChain.complete', {
    requestedListId: result.requestedListId,
    rootListId: result.rootListId,
    deletedFirestoreListIds: result.deletedFirestoreListIds,
    deletedSubsplashListIds: result.deletedSubsplashListIds,
    rootSubsplashListId: result.rootSubsplashListId,
  });
  return result;
};
