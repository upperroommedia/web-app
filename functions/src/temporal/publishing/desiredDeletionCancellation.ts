import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_CONTROL,
  assertProviderUsageMarker,
  providerResourceKey,
  prepareDesiredProviderDeletionAbort,
  type DesiredProviderDeletionType,
} from '../../../../packages/orchestration/src/provider-usage';
import { listProviderMutationSessionsForJob } from './providerMutationGuard';

/** Release desired-delete preflight claims only after original guarded work was permanently proven unsent. */
export async function abortCancelledDesiredProviderDeletions(
  db: Firestore,
  ref: DurableJobRef,
  store: { commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void> }
): Promise<void> {
  const sessions = await listProviderMutationSessionsForJob(db, ref);
  const candidates = new Map<
    string,
    {
      resource: { projectId: string; provider: 'subsplash' | 'soundcloud'; account: string; remoteId: string };
      resourceType: DesiredProviderDeletionType;
    }
  >();
  for (const session of sessions) {
    if (session.state !== 'aborted') continue;
    for (const target of session.resources) {
      if (!['media', 'track', 'tag', 'list', 'series'].includes(target.resourceType)) continue;
      const resource = {
        projectId: ref.projectId,
        provider: target.provider,
        account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
        remoteId: target.resourceId,
      };
      candidates.set(providerResourceKey(resource), {
        resource,
        resourceType: target.resourceType as DesiredProviderDeletionType,
      });
    }
  }
  if (!candidates.size) return;
  for (const candidate of candidates.values())
    await store.commitCurrent(ref, async (tx) => {
      const control = await tx.get(db.doc(PROVIDER_USAGE_CONTROL));
      // No desired reservation is possible until this authoritative index is ready.
      // A missing index therefore leaves no preflight deletion claim to release.
      if (!control.exists) return;
      const marker = assertProviderUsageMarker(control.data(), ref.projectId);
      const aggregate = await tx.get(
        db
          .collection(PROVIDER_USAGE_COLLECTION)
          .doc(providerResourceKey(candidate.resource))
          .collection('epochs')
          .doc(marker.epoch)
      );
      if (aggregate.get('state') !== 'reserved' || aggregate.get('desiredDeletionProof')?.jobId !== ref.jobId) return;
      if (aggregate.get('desiredDeletionProof')?.resourceType !== candidate.resourceType)
        throw new Error('PROVIDER_DESIRED_DELETION_ABORT_PROOF_INVALID');
      const commit = await prepareDesiredProviderDeletionAbort(tx, db, { ...candidate, jobId: ref.jobId });
      commit();
    });
}
