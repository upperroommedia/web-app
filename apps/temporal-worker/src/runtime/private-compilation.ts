import {
  assertV1PublishingSourceProducerBarrier,
  CRITICAL_REPAIR_CATALOGS,
  CRITICAL_REPAIR_SOURCE_CATALOGS,
} from '../../../../functions/src/temporal/publishing/criticalRepairCatalog';
import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';
import type { DurableJob, DurableJobRef } from '@upperroom/contracts/temporal';
import type { createDurableJobStore } from '@upperroom/orchestration/job-store';
import { ACKNOWLEDGED_REPAIR_CANDIDATES } from '../../../../functions/src/temporal/publishing/acknowledgedRepairCandidate';
import { compilePublishingCriticalRepairEvidence } from '../../../../functions/src/temporal/publishing/criticalRepairCompilation';
import { preparePublishingCriticalRepair } from '../../../../functions/src/temporal/publishing/criticalRepair';
type Store = Pick<ReturnType<typeof createDurableJobStore>, 'assertCurrentInTransaction' | 'loadJob' | 'project'>;
const deny = (): never => {
  throw Object.assign(new Error('Private repair compilation scope is invalid'), { code: 'PERMISSION_CHANGED' });
};
/** A revoked actor's original facts remain inspectable, but this writer cannot change canonical data. */
function privateCandidateTransaction(transaction: Transaction, db: Firestore): Transaction {
  let proxy: Transaction;
  proxy = new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (['create', 'set', 'update', 'delete'].includes(String(property)))
        return (reference: DocumentReference, ...args: unknown[]) => {
          const parts = reference?.path?.split('/') ?? [];
          if (
            reference.firestore !== db ||
            ![ACKNOWLEDGED_REPAIR_CANDIDATES, CRITICAL_REPAIR_CATALOGS, CRITICAL_REPAIR_SOURCE_CATALOGS].includes(
              parts[0]
            ) ||
            !parts[1] ||
            (parts[0] === ACKNOWLEDGED_REPAIR_CANDIDATES && !/^[a-f0-9]{64}$/.test(parts[1]))
          )
            deny();
          Reflect.apply(value, target, [reference, ...args]);
          return proxy;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}
export function createCriticalRepairCompilationActivities(
  db: Firestore,
  store: Store,
  projectId: string,
  assertSourceProducerBarrier?: Parameters<
    typeof compilePublishingCriticalRepairEvidence
  >[1]['assertSourceProducerBarrier']
) {
  return {
    async compilePublishingCriticalRepairEvidence(
      ref: DurableJobRef
    ): Promise<{ state: 'ready' | 'pending' | 'unavailable'; code?: string; progressed?: true }> {
      if (ref.projectId !== projectId) deny();
      let result;
      try {
        result = await compilePublishingCriticalRepairEvidence(ref, {
          firestore: db,
          assertSourceProducerBarrier:
            assertSourceProducerBarrier ?? ((tx, current) => assertV1PublishingSourceProducerBarrier(tx, db, current)),
          commitCurrent: async (current, mutate) => {
            if (current.projectId !== ref.projectId || current.jobId !== ref.jobId) deny();
            await db.runTransaction(async (tx) => {
              const intent = await store.assertCurrentInTransaction(tx, current);
              if (
                !intent.kind.startsWith('sermon.') &&
                !intent.kind.startsWith('list.') &&
                !intent.kind.startsWith('series.') &&
                intent.kind !== 'speaker.mutate' &&
                intent.kind !== 'maintenance.run'
              )
                deny();
              if (
                intent.kind === 'maintenance.run' &&
                (intent.payload as { operation?: unknown })?.operation === 'media_artifacts_cleanup'
              )
                deny();
              await mutate(privateCandidateTransaction(tx, db));
            });
          },
        });
      } catch (error) {
        if (
          [
            'PUBLISHING_CRITICAL_REPAIR_CATALOG_REQUIRED',
            'PUBLISHING_CRITICAL_REPAIR_PRODUCER_BARRIER_REQUIRED',
            'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
            'PROVIDER_MUTATION_UNRESOLVED',
            'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
          ].includes(String((error as { code?: unknown })?.code))
        )
          return { state: 'unavailable' };
        throw error;
      }
      if (result.state === 'ready') {
        let job = await store.loadJob(ref);
        if (['needs_attention', 'reconciling', 'cancel_requested'].includes(job.state)) {
          // Duplicate evidence notifications must not invalidate an administrator's
          // unchanged review by advancing its public revision again. Compare the
          // freshly derived source capability under the current SDK transaction.
          if (job.attention?.resolutionKind === 'critical_repair' && job.attention.certificateId) {
            const checked = await db.runTransaction(async (tx) => {
              await store.assertCurrentInTransaction(tx, ref);
              const current = await tx.get(db.doc(`durableJobs/${ref.jobId}`));
              const fresh = current.data() as DurableJob;
              if (
                !['needs_attention', 'reconciling', 'cancel_requested'].includes(fresh.state) ||
                fresh.attention?.resolutionKind !== 'critical_repair' ||
                !fresh.attention.certificateId
              )
                return { job: fresh, unchanged: false };
              const prepared = await preparePublishingCriticalRepair(tx, db, {
                ref,
                expectedRevision: fresh.revision,
              });
              return { job: fresh, unchanged: prepared.certificateId === fresh.attention.certificateId };
            });
            job = checked.job;
            if (checked.unchanged || !['needs_attention', 'reconciling', 'cancel_requested'].includes(job.state))
              return { state: 'ready' };
          }
          try {
            await store.project(ref, {
              expectedRevision: job.revision,
              state: job.state,
              actions: job.actions,
              attention: job.attention,
              error: job.error,
            });
          } catch (error) {
            if ((error as { code?: unknown })?.code !== 'STALE_REVISION') throw error;
            // No capability was refreshed. Re-evaluate the fresh source/job on the
            // next bounded control page rather than wait for another notification.
            return { state: 'pending', progressed: true };
          }
        }
      }
      return {
        state: result.state,
        ...(result.code ? { code: result.code } : {}),
        ...(result.state === 'pending' && 'progressed' in result && result.progressed === true
          ? { progressed: true as const }
          : {}),
      };
    },
  };
}
