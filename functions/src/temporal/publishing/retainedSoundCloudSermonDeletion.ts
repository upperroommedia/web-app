import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  SERMON_DELETION_MIRROR_PLANS,
  loadSermonDeletionMirrorPlan,
  removeSermonDeletionMirrors,
  validateSermonDeletionEffectsForClosing,
  validateSermonDeletionCompletion,
  readSermonDeletionRootMutationTargetsPage,
  readSermonDeletionCanonicalInventoryPage,
  readSermonDeletionCanonicalCompletionSummary,
  validateSermonDeletionCanonicalInventoryPage,
  type SermonDeletionMirrorPlan,
} from '../../helpers/sermonDeletionMirrors';
import {
  acknowledgedProjectionDigest,
  type FrozenProjectionRequest,
  type FrozenProviderVerification,
} from './criticalAcknowledgedRepair';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  prepareProviderMutationEffectsClosed,
  type ProviderMutationSession,
  type ProviderMutationReadyCanonicalCompletionValidator,
} from './providerMutationGuard';
import {
  loadValidatedLegacySoundCloudRetentionCertificate,
  validateLegacySoundCloudRetentionDisposition,
  type LegacySoundCloudRetentionCertificate,
  type LegacySoundCloudRetentionOperation,
} from './legacySoundCloudRetention';
import {
  compileRetainedDeletionReady,
  refreshRetainedDeletionReadyCanonicalCompletion,
  validateRetainedDeletionReadyCompletion,
  type RetainedDeletionReadyAuthority,
  type RetainedDeletionReadySource,
} from './retainedDeletionReady';
import { runCriticalPublishingRepair } from './durableOperationContext';
import { prepareDesiredProviderDeletionSettlement } from '../../../../packages/orchestration/src/provider-usage';
import { preparePublishingAllocationRetirement } from './allocationBarrier';

type Data = Record<string, any>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => {
  throw Object.assign(new Error('RETAINED_SOUNDCLOUD_SERMON_DELETION_PROOF_REQUIRED'), {
    code: 'RETAINED_SOUNDCLOUD_SERMON_DELETION_PROOF_REQUIRED',
  });
};
export interface RetainedSoundCloudSermonDeletionDependencies {
  firestore: Firestore;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
  authorizeInTransaction(
    tx: Transaction,
    ref: DurableJobRef,
    certificate: LegacySoundCloudRetentionCertificate
  ): Promise<void>;
  /** Fresh authenticated fixed-ID absence for this server-captured non-retained target,
   * including its source-owned deletion journal. Never invoked for retained SoundCloud. */
  verifyOtherProviderAbsent(target: FrozenProviderVerification): Promise<void>;
  /** Dedicated critical completion capability; validates fresh grant, admin, SDK and
   * effectsClosed, and invokes the mandatory source completion validator in this TX. */
  prepareFinalSettlement(
    tx: Transaction,
    session: ProviderMutationSession,
    validateSourceCompletion: ProviderMutationReadyCanonicalCompletionValidator
  ): Promise<{ alreadyCommitted: boolean; commit(): void }>;
}
interface Source {
  certificateId: string;
  certificate: LegacySoundCloudRetentionCertificate;
  plan: SermonDeletionMirrorPlan;
  session: ProviderMutationSession;
  state: string;
  header: Data;
  otherTargets: FrozenProviderVerification[];
}
async function source(
  tx: Transaction,
  ref: DurableJobRef,
  operation: LegacySoundCloudRetentionOperation,
  deps: RetainedSoundCloudSermonDeletionDependencies
): Promise<Source> {
  const db = deps.firestore,
    certificate = await loadValidatedLegacySoundCloudRetentionCertificate(tx, db, ref, operation.certificateId);
  await deps.authorizeInTransaction(tx, ref, certificate);
  const intent = await tx.get(db.doc(`durableJobIntents/${ref.jobId}`));
  if (
    intent.get('kind') !== 'sermon.delete' ||
    intent.get('payload.action') !== 'delete' ||
    intent.get('entity.id') !== certificate.sermonId
  )
    return fail();
  const retained = await validateLegacySoundCloudRetentionDisposition(tx, db, { ref, trackId: certificate.trackId });
  if (!retained || retained.certificateId !== operation.certificateId) return fail();
  const plan = await loadSermonDeletionMirrorPlan(db, ref, certificate.sermonId, tx);
  if (!plan.operation) return fail();
  const header = object((await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`))).data());
  if (
    !Array.isArray(header.requests) ||
    !Array.isArray(header.verifications) ||
    header.originalRoot?.soundCloudTrackId !== certificate.trackId
  )
    return fail();
  const requests = header.requests as FrozenProjectionRequest[],
    verifications = header.verifications as FrozenProviderVerification[];
  const retainedRequests = requests.filter((request) => request.target?.provider === 'soundcloud');
  if (
    retainedRequests.length !== 1 ||
    retainedRequests[0].target?.resourceId !== certificate.trackId ||
    retainedRequests[0].method !== 'DELETE'
  )
    return fail();
  const scope = { ...ref, operation: plan.operation },
    id = providerMutationFingerprint(scope),
    record = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${id}`));
  if (
    !record.exists ||
    !['active', 'committed'].includes(record.get('state')) ||
    providerMutationFingerprint(record.get('scope')) !== id
  )
    return fail();
  const session: ProviderMutationSession = { db, id, scope, resources: record.get('resources') };
  const otherTargets = verifications.filter((target) => target.provider !== 'soundcloud');
  if (
    otherTargets.length !== requests.length - 1 ||
    otherTargets.some(
      (target) =>
        target.provider !== 'subsplash' ||
        target.resourceType !== 'media' ||
        target.account !== 'app:9XTSHD' ||
        target.resourceId !== header.originalRoot.subsplashId ||
        !requests.some(
          (request) => request.target?.provider === target.provider && request.target.resourceId === target.resourceId
        )
    )
  )
    return fail();
  return {
    certificateId: operation.certificateId,
    certificate,
    plan,
    session,
    state: record.get('state'),
    header,
    otherTargets,
  };
}

function readyAuthority(current: Source): RetainedDeletionReadyAuthority {
  return {
    ...current.plan,
    certificateId: current.certificateId,
    trackId: current.certificate.trackId,
    intentFingerprint: current.certificate.intentFingerprint,
  };
}
function readySource(current: Source, db: Firestore): RetainedDeletionReadySource {
  return {
    readExpectedRequests: async (tx, cursor) => {
      const page = await readSermonDeletionRootMutationTargetsPage(tx, db, {
        ref: current.plan,
        sermonId: current.plan.sermonId,
        cursor,
        limit: 32,
      });
      const indices = page.targets.length
        ? await tx.getAll(
            ...page.targets.map((row) =>
              db.doc(
                `temporalPublishingAcknowledgedProjections/${
                  current.session.id
                }/requestIndex/${providerMutationFingerprint(row.requestStep)}`
              )
            )
          )
        : [];
      const requests = indices.map((row, index) => {
        const request = row.get('request') as FrozenProjectionRequest | undefined;
        if (
          !request ||
          request.step !== page.targets[index].requestStep ||
          acknowledgedProjectionDigest(request.target) !== acknowledgedProjectionDigest(page.targets[index].target)
        )
          return fail();
        return request;
      });
      return {
        requests,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        sourceProgramDigest: page.sourceProgramDigest,
        sourceRequestCount: page.sourceRequestCount,
      };
    },
    readCanonicalInventory: (tx, cursor) =>
      readSermonDeletionCanonicalInventoryPage(tx, db, {
        ref: current.plan,
        sermonId: current.plan.sermonId,
        cursor,
        limit: 32,
      }),
    validateCanonicalPage: (tx, input) =>
      validateSermonDeletionCanonicalInventoryPage(tx, db, {
        ref: current.plan,
        sermonId: current.plan.sermonId,
        ...input,
      }),
    validateCanonicalCompletion: (tx) => readSermonDeletionCanonicalCompletionSummary(tx, db, current.plan),
  };
}
/** Finishes only the captured original sermon.delete program. A reviewed retained
 * resource qualifies NoSEND and is never asserted absent or sent another DELETE. */
export async function finalizeRetainedSoundCloudSermonDeletion(
  ref: DurableJobRef,
  operation: LegacySoundCloudRetentionOperation,
  deps: RetainedSoundCloudSermonDeletionDependencies
): Promise<{ state: 'completed'; planId: string; settledMutationSessionId: string }> {
  if (
    !operation ||
    Object.keys(operation).length !== 2 ||
    operation.kind !== 'legacy_soundcloud_retain' ||
    !sha(operation.certificateId) ||
    typeof deps.commitCurrent !== 'function' ||
    typeof deps.authorizeInTransaction !== 'function' ||
    typeof deps.verifyOtherProviderAbsent !== 'function' ||
    typeof deps.prepareFinalSettlement !== 'function'
  )
    return fail();
  let captured: Source | undefined;
  await deps.commitCurrent(ref, async (tx) => {
    captured = await source(tx, ref, operation, deps);
  });
  if (!captured) return fail();
  const initial = captured as Source;
  const adapter = readySource(initial, deps.firestore),
    authority = readyAuthority(initial);
  await compileRetainedDeletionReady(authority, initial.session, adapter, {
    firestore: deps.firestore,
    commitCurrent: deps.commitCurrent,
    authorize: async (tx) => {
      await source(tx, ref, operation, deps);
    },
  });
  for (const target of initial.otherTargets) await deps.verifyOtherProviderAbsent(target);
  await deps.commitCurrent(ref, async (tx) => {
    const current = await source(tx, ref, operation, deps);
    if (current.state === 'committed') {
      await validateSermonDeletionCompletion(tx, deps.firestore, current.plan);
      return;
    }
    const closure = await prepareProviderMutationEffectsClosed(tx, current.session, (transaction) =>
      validateSermonDeletionEffectsForClosing(transaction, deps.firestore, current.plan)
    );
    const root = await tx.get(deps.firestore.doc(`sermons/${current.plan.sermonId}`));
    const retirements: Array<() => void> = [];
    if (root.exists) {
      // Retention already cleared only the SoundCloud identity. Clear remaining
      // positively acknowledged/absent pointers to the exact captured root SHA.
      const original: Record<string, any> = {
        ...object(current.header.originalRoot),
        status: { ...object(current.header.originalRoot?.status) },
      };
      delete original.soundCloudTrackId;
      delete original.soundCloudTrackUrl;
      delete original.soundCloudPublication;
      original.status.soundCloud = 'NOT_UPLOADED';
      if (
        ![acknowledgedProjectionDigest(original), current.header.pointerClearRootDigest].includes(
          acknowledgedProjectionDigest(root.data())
        )
      )
        return fail();
      for (const target of current.otherTargets)
        retirements.push(
          await preparePublishingAllocationRetirement(
            tx,
            deps.firestore,
            { ref, sermonId: current.plan.sermonId, provider: target.provider },
            target.resourceId
          )
        );
    }
    // All preparation reads precede every canonical/private write.
    if (root.exists && current.otherTargets.some((target) => target.provider === 'subsplash'))
      tx.update(root.ref, { subsplashId: FieldValue.delete(), 'status.subsplash': 'NOT_UPLOADED' });
    for (const commit of retirements) commit();
    closure.commit();
  });
  await runCriticalPublishingRepair(
    ref.jobId,
    () =>
      removeSermonDeletionMirrors(deps.firestore, initial.plan, {
        assertOriginalProviderEffects: async (tx) => {
          const current = await source(tx, ref, operation, deps);
          await validateSermonDeletionEffectsForClosing(tx, deps.firestore, current.plan);
        },
      }),
    (mutate) => deps.commitCurrent(ref, mutate)
  );
  await refreshRetainedDeletionReadyCanonicalCompletion(authority, initial.session, adapter, {
    firestore: deps.firestore,
    commitCurrent: deps.commitCurrent,
    authorize: async (tx) => {
      await source(tx, ref, operation, deps);
    },
  });
  await deps.commitCurrent(ref, async (tx) => {
    const current = await source(tx, ref, operation, deps);
    const settlement = await deps.prepareFinalSettlement(
      tx,
      current.session,
      async (transaction, settlementSession, seal) => {
        await source(transaction, ref, operation, deps);
        if (settlementSession.id !== current.session.id) return fail();
        await validateSermonDeletionCompletion(transaction, deps.firestore, current.plan, seal);
        return validateRetainedDeletionReadyCompletion(
          transaction,
          authority,
          settlementSession,
          seal,
          adapter,
          deps.firestore
        );
      }
    );
    if (settlement.alreadyCommitted) return;
    const indexSettlements: Array<() => void> = [];
    for (const target of current.otherTargets)
      indexSettlements.push(
        await prepareDesiredProviderDeletionSettlement(tx, deps.firestore, {
          resource: {
            projectId: ref.projectId,
            provider: target.provider,
            account: target.account,
            remoteId: target.resourceId,
          },
          jobId: ref.jobId,
          resourceType: 'media',
        })
      );
    for (const commit of indexSettlements) commit();
    settlement.commit();
  });
  return { state: 'completed', planId: initial.plan.planId, settledMutationSessionId: initial.session.id };
}
