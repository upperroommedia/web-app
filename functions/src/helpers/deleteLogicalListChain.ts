import {markPublishingCritical, getPublishingMutationOperation, runPublishingProviderMutation} from '../temporal/publishing/durableOperationContext';
import { providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import { assertSynchronousProviderMutationCompleted } from '../temporal/publishing/providerMutationCompletion';
import { FieldPath, type DocumentReference } from 'firebase-admin/firestore';
import { isDurablePublishingOperation } from '../temporal/publishing/durableOperationContext';
import axios, { isAxiosError } from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { createAxiosConfig, authenticateSubsplash } from '../subsplashUtils';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';
import { getOverflowChainState } from './listOverflowChain';
import { listDebugLog, summarizeOverflowNodes } from './listDebugLogger';
import { prepareListDeletionMirrors, removeListDeletionMirrors, recordListDeletionProviderAbsence, deleteListDeletionCanonicalPage, type ListDeletionMirrorPlan } from './listDeletionMirrors';

const firestore = firebaseAdmin.firestore();

const deleteSubsplashListIgnoringNotFound = async (subsplashListId: string, token: string): Promise<void> => {
  const url = `https://core.subsplash.com/builder/v1/lists/${subsplashListId}`;
  await markPublishingCritical('PUBLISHING_DELETE_CRITICAL', {
    provider: 'subsplash', resourceType: 'list', resourceId: subsplashListId, accountId: 'app:9XTSHD', method: 'DELETE',
  });
  const config = createAxiosConfig(url, token, 'DELETE');

  Object.assign(config, { skipSubsplashEdgeRetry: true, maxRedirects: 0 });
  const payload = { id: subsplashListId };
  try { await runPublishingProviderMutation({
    operation: getPublishingMutationOperation() ?? 'legacy-list-mutation',
    step: `delete-logical-list:${subsplashListId}:${providerPayloadFingerprint(payload)}`,
    target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: subsplashListId },
    method: 'DELETE', payload,
    send: async () => {
      try {
        assertSynchronousProviderMutationCompleted(await axios(config));
        return { completion: 'acknowledged', result: null };
      } catch (error) {
        if (isAxiosError(error)) {
          if (error.response?.status === 404 || error.response?.status === 410) {
            logger.log('deleteLogicalListChain.remoteDelete.notFound', { subsplashListId });
            return { completion: 'rejected_no_effect', evidence: { transport: 'original_http_response', status: error.response.status, providerCode: 'resource_not_found' } };
          }
        }
        throw error;
      }
    },
  }); } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 'PROVIDER_MUTATION_REJECTED_NO_EFFECT' && !(error instanceof Error && error.message === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT')) throw error;
    // Rejection is not an ACK. The normal desired-delete path still requires a fresh
    // authenticated absence read before any canonical cleanup; unknown outcomes stop.
  }
};

/** A successful DELETE acknowledgement alone is insufficient evidence to prune
 * canonical state. Read the exact authenticated target again and require absence.
 */
const verifySubsplashListAbsent = async (subsplashListId: string, token: string): Promise<void> => {
  const config = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${subsplashListId}`, token, 'GET');
  Object.assign(config, { skipSubsplashEdgeRetry: true, maxRedirects: 0 });
  try {
    const response = await axios(config);
    if (response.status === 404 || response.status === 410) return;
  } catch (error) {
    if (isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 410)) return;
    throw error;
  }
  throw new Error('PROVIDER_LIST_ABSENCE_NOT_CONFIRMED');
};

export interface DeleteLogicalListChainResult {
  requestedListId: string;
  rootListId: string;
  deletedFirestoreListIds: string[];
  deletedSubsplashListIds: string[];
  rootSubsplashListId?: string;
}


/** Keep deletion pages bounded and fence every canonical commit during durable execution. */
const deleteDurableDescendants = async (ref: DocumentReference, plan: ListDeletionMirrorPlan, depth = 0): Promise<void> => {
  if(depth>16) throw new Error('List subtree exceeds the supported deletion depth.');
  const children=await ref.listCollections();
  for(const child of children) {
    while(true) {
      const page=await child.orderBy(FieldPath.documentId()).limit(200).get();
      if(page.empty) break;
      for(const doc of page.docs) await deleteDurableDescendants(doc.ref,plan,depth+1);
      await deleteListDeletionCanonicalPage(firestore, plan, page.docs.map((doc) => doc.ref));
    }
  }
};
const deleteDurableSubtree = async (ref:DocumentReference, plan: ListDeletionMirrorPlan):Promise<void> => {
  await deleteDurableDescendants(ref, plan);
  await deleteListDeletionCanonicalPage(firestore, plan, [ref]);
};


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
  const mirrorPlan = deletedFirestoreListIds.length ? await prepareListDeletionMirrors(firestore, {
    rootListId: chainState.rootListId, firestoreListIds: deletedFirestoreListIds,
    remoteListIds: [...new Set(deletedSubsplashListIds)],
  }) : undefined;

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
        for (const subsplashListId of remoteDeleteIds) await verifySubsplashListAbsent(subsplashListId, token);
      },
      {
        ...(operationKey ? { operationKey } : {}),
      }
    );
  }

  if(isDurablePublishingOperation()&&mirrorPlan)await recordListDeletionProviderAbsence(firestore,mirrorPlan);

  for (const firestoreListId of deletedFirestoreListIds) {
    listDebugLog('deleteLogicalListChain.firestoreDelete', {
      requestedListId: listId,
      firestoreListId,
    });
    const ref=firestore.collection('lists').doc(firestoreListId);
    if(isDurablePublishingOperation()) {
      if (!mirrorPlan) throw new Error('LIST_DELETION_MIRROR_PLAN_REQUIRED');
      await deleteDurableSubtree(ref, mirrorPlan);
    }
    else await firestore.recursiveDelete(ref);
  }

  // Remove projections before canonical sermon mirrors. Their deletion listeners
  // then find no listItems row to rewrite over the frozen deletion fingerprint.
  if (mirrorPlan) await removeListDeletionMirrors(firestore, mirrorPlan);

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
