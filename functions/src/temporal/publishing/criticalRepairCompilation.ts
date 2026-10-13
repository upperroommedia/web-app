import { compileSermonDeletionPartialStopPage } from '../../helpers/sermonDeletionPartialStop';
import {
  prepareCriticalRepairCatalogSourceSeal,
  compileCriticalRepairCatalogPage,
  type CriticalRepairCatalogRoot,
} from './criticalRepairCatalog';
import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { PROVIDER_MUTATION_SESSIONS } from './providerMutationGuard';
import {
  compileAcknowledgedRepairCandidatePage,
  type AcknowledgedRepairCandidateResult,
} from './acknowledgedRepairCandidate';
export interface CriticalRepairCompilationStore {
  firestore: Firestore;
  assertSourceProducerBarrier(
    tx: Transaction,
    ref: DurableJobRef
  ): Promise<{ allSourceWritersEnrolled: true; originalSourceProgramsFrozen: true }>;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
/** A controls activity compiles one private evidence page. It never reads a provider,
 * changes canonical records, or turns an uncertain HTTP request into a completion. */
export async function compilePublishingCriticalRepairEvidence(
  ref: DurableJobRef,
  store: CriticalRepairCompilationStore
): Promise<{
  state: 'ready' | 'pending';
  progressed?: true;
  code?: 'PUBLISHING_CRITICAL_REPAIR_PREPARING';
  candidate?: AcknowledgedRepairCandidateResult;
  catalog?: CriticalRepairCatalogRoot;
}> {
  if (typeof store.assertSourceProducerBarrier !== 'function')
    throw new Error('PUBLISHING_CRITICAL_REPAIR_PRODUCER_BARRIER_REQUIRED');
  await store.commitCurrent(ref, async (tx) => {
    const seal = await prepareCriticalRepairCatalogSourceSeal(tx, store.firestore, ref, (current) =>
      store.assertSourceProducerBarrier(current, ref)
    );
    seal.commit();
  });
  const catalog = await compileCriticalRepairCatalogPage(store.firestore, ref, store);
  if (catalog.state !== 'ready')
    return { state: 'pending', progressed: true, code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING', catalog: catalog.root };
  const page = await store.firestore
    .collection(PROVIDER_MUTATION_SESSIONS)
    .where('scope.projectId', '==', ref.projectId)
    .where('scope.jobId', '==', ref.jobId)
    .where('state', '==', 'active')
    .orderBy(FieldPath.documentId())
    .limit(2)
    .get();
  if (page.empty) return { state: 'ready', catalog: catalog.root };
  // Original execution holds at most one logical mutable plan for a job. Refuse
  // to certify a broken ownership graph rather than hiding a second session.
  if (page.size > 1) throw new Error('PUBLISHING_CRITICAL_REPAIR_MULTIPLE_ACTIVE_PLANS');
  const requests = page.docs[0].ref.collection('requests');
  const [positive, noEffect, unsettled] = await Promise.all([
    requests.where('state', '==', 'acknowledged').limit(1).get(),
    requests.where('state', '==', 'rejected_no_effect').limit(1).get(),
    requests.where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable']).limit(1).get(),
  ]);
  // Both original ACK and sealed no-effect facts may support source-specific review.
  // Unknown transports stay held; no provider read supplies their missing completion.
  if ((positive.empty && noEffect.empty) || !unsettled.empty) return { state: 'ready', catalog: catalog.root };
  const candidate = await compileAcknowledgedRepairCandidatePage(store.firestore, ref, page.docs[0].id, {
    commitCurrent: async <T>(current: DurableJobRef, mutate: (tx: Transaction) => Promise<T>): Promise<T> => {
      let result: T | undefined;
      await store.commitCurrent(current, async (tx) => {
        result = await mutate(tx);
      });
      return result as T;
    },
  });
  if (candidate.state !== 'ready')
    return {
      state: 'pending',
      progressed: true,
      code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING',
      candidate,
      catalog: catalog.root,
    };
  const intent = await store.firestore.doc(`durableJobIntents/${ref.jobId}`).get();
  if (intent.get('kind') === 'sermon.delete') {
    try {
      const partial = await compileSermonDeletionPartialStopPage(store.firestore, ref, page.docs[0].id, {
        commitCurrent: async <T>(current: DurableJobRef, mutate: (tx: Transaction) => Promise<T>): Promise<T> => {
          let result: T | undefined;
          await store.commitCurrent(current, async (tx) => {
            result = await mutate(tx);
          });
          return result as T;
        },
      });
      if (partial.state !== 'ready')
        return {
          state: 'pending',
          progressed: true,
          code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING',
          candidate,
          catalog: catalog.root,
        };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED') throw error;
      // A complete deletion or a root already removed follows its existing exact
      // factual cleanup certificate; it cannot become a content-preserving stop.
    }
  }
  return { state: 'ready', candidate, catalog: catalog.root };
}
