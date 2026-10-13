import { FieldValue, type Firestore, type Transaction, type DocumentSnapshot } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { PUBLISHING_SOURCE_PROTOCOL } from '../../../../packages/orchestration/src/job-store';
import { MEDIA_ARTIFACTS, mediaReferenceId } from '../../../../packages/orchestration/src/media-artifacts';
import {
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_CONTROL,
  assertProviderUsageMarker,
  providerResourceKey,
  desiredProviderDeletionDocumentFingerprint,
  prepareDesiredProviderDeletionZeroEffectsAbort,
  type DesiredProviderDeletionType,
} from '../../../../packages/orchestration/src/provider-usage';
import { SERMON_DELETION_MIRROR_PLANS, sermonDeletionMirrorPlanId } from '../../helpers/sermonDeletionMirrors';
import { localSermonDeletionHeaderProjection } from './localSermonDeletionRepair';
import { ACKNOWLEDGED_PROJECTION_PLANS, acknowledgedProjectionDigest as digest } from './criticalAcknowledgedRepair';
import { CRITICAL_REPAIR_SOURCE_CATALOGS, criticalRepairCatalogDigest } from './criticalRepairCatalog';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  prepareZeroEffectsProviderMutationAbort,
  assertProviderMutationZeroEffectsProof,
  type ProviderMutationSession,
  type ProviderMutationResource,
} from './providerMutationGuard';
export const PUBLISHING_ZERO_EFFECTS_STOPS = 'temporalPublishingZeroEffectsStops';
export type PublishingZeroEffectsStopOperation = Readonly<{
  kind: 'publishing_zero_effects_stop';
  planId: string;
  sessionId: string;
}>;
export interface PublishingZeroEffectsStopDependencies {
  firestore: Firestore;
  authorizeInTransaction(
    tx: Transaction,
    ref: DurableJobRef,
    operation: PublishingZeroEffectsStopOperation
  ): Promise<void>;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const fail = (): never => {
  throw Object.assign(new Error('PUBLISHING_ZERO_EFFECTS_STOP_PROOF_REQUIRED'), {
    code: 'PUBLISHING_ZERO_EFFECTS_STOP_PROOF_REQUIRED',
  });
};
const absent = (value: unknown) => value === undefined || value === null;
function evidenceIdentity(record: Data): Data {
  const { state, stoppedAtMillis, ...identity } = record;
  return identity;
}
function headerIdentity(header: Data): Data {
  return {
    ...localSermonDeletionHeaderProjection(header),
    ...Object.fromEntries(
      [
        'destinationProgram',
        'frozenProgramDigest',
        'canonicalPageCount',
        'canonicalChainDigest',
        'immutableCanonicalCatalogDigest',
      ]
        .filter((key) => header[key] !== undefined)
        .map((key) => [key, header[key]])
    ),
  };
}
export function validatePublishingZeroEffectsStopOperation(
  value: unknown
): value is PublishingZeroEffectsStopOperation {
  const op = object(value);
  return (
    Object.keys(op).length === 3 && op.kind === 'publishing_zero_effects_stop' && sha(op.planId) && sha(op.sessionId)
  );
}
interface Source {
  operation: PublishingZeroEffectsStopOperation;
  sourceEvidence: { path: string; digest: string };
  sourceEvidenceDigest: string;
  identity: Data;
  session: ProviderMutationSession;
  sermonId: string;
  alreadyStopped: boolean;
  stored: boolean;
  commit(): void;
}
/** Every gate is private source evidence. Neither an operator assertion nor a provider GET is zero-effect proof. */
async function readSource(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number; operation?: PublishingZeroEffectsStopOperation }
): Promise<Source> {
  const { ref } = input;
  if (!safe(ref.projectId) || !safe(ref.jobId)) return fail();
  const [jobDoc, intentDoc, criticalDoc, catalogDoc] = await Promise.all([
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`durableJobCriticalSections/${ref.jobId}`)),
    tx.get(db.doc(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`)),
  ]);
  const job = object(jobDoc.data()),
    intent = object(intentDoc.data()),
    critical = object(criticalDoc.data()),
    catalog = object(catalogDoc.data()),
    entity = object(intent.entity),
    domain = object(intent.payload),
    sermonId = entity.id;
  if (
    !jobDoc.exists ||
    !intentDoc.exists ||
    !criticalDoc.exists ||
    !catalogDoc.exists ||
    intent.schemaVersion !== 1 ||
    intent.publishingSourceProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.kind !== 'sermon.delete' ||
    job.kind !== intent.kind ||
    entity.type !== 'sermon' ||
    !safe(sermonId) ||
    digest(job.entity) !== digest(entity) ||
    domain.sermonId !== sermonId ||
    domain.action !== 'delete' ||
    domain.generation !== intent.generation ||
    job.generation !== intent.generation ||
    !Number.isSafeInteger(intent.generation) ||
    Number(intent.generation) < 1 ||
    !safe(job.workflowId) ||
    !['running', 'retrying', 'reconciling', 'needs_attention', 'cancel_requested'].includes(String(job.state)) ||
    (input.expectedRevision !== undefined && job.revision !== input.expectedRevision)
  )
    return fail();
  const { sealDigest, ...catalogBody } = catalog;
  if (
    catalog.schemaVersion !== 1 ||
    catalog.producerProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    catalog.sealed !== true ||
    !sha(sealDigest) ||
    sealDigest !== criticalRepairCatalogDigest(catalogBody) ||
    catalog.projectId !== ref.projectId ||
    catalog.jobId !== ref.jobId ||
    catalog.generation !== intent.generation ||
    catalog.workflowId !== job.workflowId ||
    catalog.intentDigest !== criticalRepairCatalogDigest(intent) ||
    catalog.criticalDigest !== criticalRepairCatalogDigest(critical) ||
    !Number.isSafeInteger(catalog.count) ||
    Number(catalog.count) < 0 ||
    !sha(catalog.sourceProgramChainDigest)
  )
    return fail();
  const planId = sermonDeletionMirrorPlanId(ref, sermonId),
    headerPath = `${SERMON_DELETION_MIRROR_PLANS}/${planId}`;
  const [headerDoc, rootDoc, mediaDoc, refsDoc, planningDoc, stopDoc] = await Promise.all([
    tx.get(db.doc(headerPath)),
    tx.get(db.doc(`sermons/${sermonId}`)),
    tx.get(db.doc(`temporalMediaState/${sermonId}`)),
    tx.get(db.doc(`temporalMediaCanonicalRefs/${sermonId}`)),
    tx.get(db.doc(`temporalMediaDeletionEffects/${ref.jobId}`)),
    tx.get(db.doc(`${PUBLISHING_ZERO_EFFECTS_STOPS}/${planId}`)),
  ]);
  const header = object(headerDoc.data()),
    media = object(mediaDoc.data()),
    refs = object(refsDoc.data()),
    planning = object(planningDoc.data()),
    saved = object(stopDoc.data()),
    alreadyStopped = saved.state === 'stopped';
  if (
    !headerDoc.exists ||
    header.schemaVersion !== 1 ||
    header.planId !== planId ||
    header.projectId !== ref.projectId ||
    header.jobId !== ref.jobId ||
    header.sermonId !== sermonId ||
    header.generation !== intent.generation ||
    header.workflowId !== job.workflowId ||
    header.intentFingerprint !== desiredProviderDeletionDocumentFingerprint(intent) ||
    header.state !== 'prepared' ||
    !absent(header.rootRemoval) ||
    !sha(header.originalRootDigest) ||
    !rootDoc.exists ||
    digest(rootDoc.data()) !== header.originalRootDigest ||
    digest(header.originalRoot) !== header.originalRootDigest ||
    !safe(header.operation) ||
    !sha(header.frozenProgramDigest) ||
    !sha(header.immutableCanonicalCatalogDigest) ||
    !Number.isSafeInteger(header.canonicalPageCount) ||
    Number(header.canonicalPageCount) < 1 ||
    !Array.isArray(header.requests) ||
    header.requests.length < 1 ||
    !Array.isArray(header.verifications) ||
    header.verifications.length < 1
  )
    return fail();
  const originalRoot = object(header.originalRoot);
  if (!safe(originalRoot.subsplashId) && !safe(originalRoot.soundCloudTrackId)) return fail();
  for (const [provider, field, type] of [
    ['subsplash', 'subsplashId', 'media'],
    ['soundcloud', 'soundCloudTrackId', 'track'],
  ] as const) {
    const remote = originalRoot[field];
    if (!safe(remote)) continue;
    if (
      !(header.requests as unknown[]).some((value) => {
        const request = object(value),
          target = object(request.target);
        return (
          request.method === 'DELETE' &&
          sha(request.fingerprint) &&
          target.provider === provider &&
          target.resourceType === type &&
          target.resourceId === remote &&
          (provider === 'subsplash'
            ? target.account === 'app:9XTSHD'
            : typeof target.account === 'string' && /^soundcloud:users:[0-9]+$/.test(target.account))
        );
      }) ||
      !(header.verifications as unknown[]).some((value) => {
        const verification = object(value);
        return (
          verification.provider === provider &&
          verification.resourceType === type &&
          verification.resourceId === remote &&
          verification.expectedState === 'absent'
        );
      })
    )
      return fail();
  }
  const sessionId = providerMutationFingerprint({
    projectId: ref.projectId,
    jobId: ref.jobId,
    operation: header.operation,
  });
  const operation: PublishingZeroEffectsStopOperation = { kind: 'publishing_zero_effects_stop', planId, sessionId };
  if (input.operation && digest(input.operation) !== digest(operation)) return fail();
  const [heldDoc, frozenDoc, sessions, creates, canonicalProgress] = await Promise.all([
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)),
    tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`)),
    tx.get(
      db
        .collection(PROVIDER_MUTATION_SESSIONS)
        .where('scope.projectId', '==', ref.projectId)
        .where('scope.jobId', '==', ref.jobId)
        .limit(2)
    ),
    tx.get(
      db
        .collection('temporalProviderReceipts')
        .where('projectId', '==', ref.projectId)
        .where('jobId', '==', ref.jobId)
        .limit(1)
    ),
    tx.get(db.doc(`temporalPublishingAcknowledgedProjectionProgress/${sessionId}`)),
  ]);
  const held = object(heldDoc.data()),
    frozen = object(frozenDoc.data());
  if (
    !heldDoc.exists ||
    sessions.size !== 1 ||
    sessions.docs[0].id !== sessionId ||
    !creates.empty ||
    canonicalProgress.exists ||
    held.schemaVersion !== 1 ||
    !['active', 'aborted'].includes(String(held.state)) ||
    digest(held.scope) !== digest({ projectId: ref.projectId, jobId: ref.jobId, operation: header.operation }) ||
    !Array.isArray(held.resources) ||
    held.resources.length < 1 ||
    !frozenDoc.exists ||
    frozen.schemaVersion !== 2 ||
    frozen.projectId !== ref.projectId ||
    frozen.jobId !== ref.jobId ||
    frozen.sessionId !== sessionId ||
    frozen.operation !== header.operation ||
    frozen.intentFingerprint !== digest(intent) ||
    digest(frozen) !== header.frozenProgramDigest ||
    !Number.isSafeInteger(frozen.requestCount) ||
    Number(frozen.requestCount) < 1 ||
    !Number.isSafeInteger(frozen.pageCount) ||
    Number(frozen.pageCount) < 1 ||
    !sha(frozen.chainDigest)
  )
    return fail();
  const originalRequests = db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`).collection('requests');
  const [actualCount, anyRequest] = await Promise.all([
    tx.get(originalRequests.count()),
    tx.get(originalRequests.limit(1)),
  ]);
  if (
    actualCount.data().count !== 0 ||
    !anyRequest.empty ||
    (held.effectsClosed === true &&
      (held.effectsClosedClaimSetDigestVersion !== 2 ||
        held.effectsClosedActualRequestCount !== 0 ||
        held.effectsClosedClaimSetDigest !== providerMutationClaimSetSeed(sessionId)))
  )
    return fail();
  const index = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`).collection('requestIndex');
  const [indexCount, readyCount] = await Promise.all([
    tx.get(index.count()),
    tx.get(index.where('ready', '==', true).where('intentFingerprint', '==', frozen.intentFingerprint).count()),
  ]);
  if (indexCount.data().count !== frozen.requestCount || readyCount.data().count !== frozen.requestCount) return fail();
  if (
    !mediaDoc.exists ||
    media.projectId !== ref.projectId ||
    !absent(media.runningRef) ||
    refs.deletionJobId === ref.jobId ||
    (refs.releasedAt !== undefined && Number(refs.releasedAt) >= Number(job.createdAt))
  )
    return fail();
  const owner = object(media.deletionParentRef);
  if (alreadyStopped) {
    if (!absent(media.deletionParentRef) || planningDoc.exists) return fail();
  } else if (
    owner.projectId !== ref.projectId ||
    owner.jobId !== ref.jobId ||
    !planningDoc.exists ||
    planning.projectId !== ref.projectId ||
    planning.deletionEffectsStarted !== true
  )
    return fail();
  if (refsDoc.exists && refs.projectId !== ref.projectId) return fail();
  const artifacts = object(refs.artifactIds),
    artifactEvidence: Array<{ slot: string; artifactId: string; referenceDigest: string }> = [];
  for (const [slot, artifactId] of Object.entries(artifacts)) {
    if (!sha(artifactId) || !safe(slot)) return fail();
    const artifactDocuments: DocumentSnapshot[] = await Promise.all([
      tx.get(db.doc(`${MEDIA_ARTIFACTS}/${artifactId}`)),
      tx.get(db.doc(`${MEDIA_ARTIFACTS}/${artifactId}/references/${mediaReferenceId('canonical', sermonId, slot)}`)),
    ]);
    const artifact = artifactDocuments[0],
      reference = artifactDocuments[1];
    if (
      !artifact.exists ||
      artifact.get('projectId') !== ref.projectId ||
      artifact.get('sermonId') !== sermonId ||
      !['uploading', 'retained'].includes(artifact.get('status')) ||
      reference.get('projectId') !== ref.projectId ||
      reference.get('type') !== 'canonical' ||
      reference.get('jobId') !== sermonId ||
      reference.get('slot') !== slot ||
      reference.get('state') !== 'active'
    )
      return fail();
    artifactEvidence.push({ slot, artifactId, referenceDigest: digest(reference.data()) });
  }
  const identity: Data = {
    schemaVersion: 1,
    ...ref,
    planId,
    sessionId,
    sermonId,
    generation: intent.generation,
    workflowId: job.workflowId,
    intentFingerprint: digest(intent),
    headerDigest: digest(headerIdentity(header)),
    sourceCatalogSealDigest: sealDigest,
    sourceProgramDigest: header.frozenProgramDigest,
    sourceRequestCount: frozen.requestCount,
    originalRequestCount: 0,
    claimSetDigestVersion: 2,
    terminalClaimSetDigest: providerMutationClaimSetSeed(sessionId),
    sourceCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
    sourceCanonicalPageCount: header.canonicalPageCount,
    originalRootDigest: header.originalRootDigest,
    sessionScopeDigest: digest({ scope: held.scope, resources: held.resources }),
    canonicalRefsDigest: digest(refsDoc.exists ? refs : null),
    artifactEvidence,
  };
  if (stopDoc.exists && digest(evidenceIdentity(saved)) !== digest(identity)) return fail();
  const sourceEvidenceDigest = digest(identity),
    sourceEvidence = { path: `${PUBLISHING_ZERO_EFFECTS_STOPS}/${planId}`, digest: sourceEvidenceDigest },
    session: ProviderMutationSession = {
      db,
      id: sessionId,
      scope: { ...ref, operation: header.operation },
      resources: held.resources as ProviderMutationResource[],
    };
  return {
    operation,
    sourceEvidence,
    sourceEvidenceDigest,
    identity,
    session,
    sermonId,
    alreadyStopped,
    stored: stopDoc.exists,
    commit: () => {
      if (!stopDoc.exists) tx.create(db.doc(sourceEvidence.path), { ...identity, state: 'prepared' });
    },
  };
}
export async function preparePublishingZeroEffectsStop(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number }
): Promise<Source> {
  const source = await readSource(tx, db, input);
  await prepareZeroEffectsProviderMutationAbort(tx, source.session, async () => ({
    sourceProgramDigest: String(source.identity.sourceProgramDigest),
  }));
  return source;
}
export async function validatePublishingZeroEffectsStopEvidence(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  evidence: { path: string; digest: string }
): Promise<void> {
  const source = await readSource(tx, db, { ref });
  if (
    !source.stored ||
    !evidence ||
    Object.keys(evidence).length !== 2 ||
    evidence.path !== source.sourceEvidence.path ||
    evidence.digest !== source.sourceEvidenceDigest
  )
    return fail();
}
export async function runPublishingZeroEffectsStop(
  ref: DurableJobRef,
  operation: PublishingZeroEffectsStopOperation,
  deps: PublishingZeroEffectsStopDependencies
): Promise<{
  state: 'completed';
  mode: 'partial_stop';
  providerEffects: 'not_started';
  contentPreserved: true;
  planId: string;
  sessionId: string;
}> {
  if (
    !validatePublishingZeroEffectsStopOperation(operation) ||
    typeof deps.authorizeInTransaction !== 'function' ||
    typeof deps.commitCurrent !== 'function'
  )
    return fail();
  await deps.commitCurrent(ref, async (tx) => {
    await deps.authorizeInTransaction(tx, ref, operation);
    const source = await readSource(tx, deps.firestore, { ref, operation });
    if (!source.stored) return fail();
    const grant = await tx.get(deps.firestore.doc(`durableJobCriticalRepairGrants/${ref.jobId}`));
    if (
      grant.get('schemaVersion') !== 1 ||
      grant.get('projectId') !== ref.projectId ||
      grant.get('jobId') !== ref.jobId ||
      grant.get('generation') !== source.identity.generation ||
      grant.get('workflowId') !== source.identity.workflowId ||
      grant.get('intentFingerprint') !== source.identity.intentFingerprint ||
      !safe(grant.get('actorUid')) ||
      !safe(grant.get('commandId')) ||
      !sha(grant.get('certificateId')) ||
      !Array.isArray(grant.get('operations')) ||
      !grant.get('operations').some((op: unknown) => digest(op) === digest(operation)) ||
      !grant.get('sourceEvidenceDigests')?.includes(source.sourceEvidenceDigest)
    )
      return fail();
    const currentJob = await tx.get(deps.firestore.doc(`durableJobs/${ref.jobId}`));
    if (currentJob.get('state') === 'cancel_requested') {
      const cancellation = await tx.get(deps.firestore.doc(`durableJobCancellationIntents/${ref.jobId}`));
      if (
        cancellation.get('projectId') !== ref.projectId ||
        cancellation.get('jobId') !== ref.jobId ||
        cancellation.get('generation') !== source.identity.generation ||
        cancellation.get('workflowId') !== source.identity.workflowId ||
        cancellation.get('purpose') !== 'critical_repair_cleanup' ||
        cancellation.get('certificateId') !== grant.get('certificateId')
      )
        return fail();
    }
    const zero = await prepareZeroEffectsProviderMutationAbort(tx, source.session, async () => ({
      sourceProgramDigest: String(source.identity.sourceProgramDigest),
    }));
    const indexClosures: Array<() => void> = [],
      control = await tx.get(deps.firestore.doc(PROVIDER_USAGE_CONTROL));
    if (control.exists) {
      const marker = assertProviderUsageMarker(control.data(), ref.projectId);
      for (const target of source.session.resources) {
        if (!['media', 'track', 'tag', 'list', 'series'].includes(target.resourceType)) continue;
        const resource = {
            projectId: ref.projectId,
            provider: target.provider,
            account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
            remoteId: target.resourceId,
          },
          aggregate = await tx.get(
            deps.firestore.doc(`${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(resource)}/epochs/${marker.epoch}`)
          );
        if (aggregate.get('state') !== 'reserved' || aggregate.get('desiredDeletionProof.jobId') !== ref.jobId)
          continue;
        indexClosures.push(
          await prepareDesiredProviderDeletionZeroEffectsAbort(
            tx,
            deps.firestore,
            { resource, resourceType: target.resourceType as DesiredProviderDeletionType, jobId: ref.jobId },
            zero.proof,
            async (transaction, proof, binding) => {
              if (proof !== zero.proof) return fail();
              assertProviderMutationZeroEffectsProof(transaction, zero.proof, { ...ref, sessionId: source.session.id });
              if (
                binding.projectId !== ref.projectId ||
                binding.jobId !== ref.jobId ||
                !source.session.resources.some(
                  (value) =>
                    value.provider === binding.resource.provider &&
                    value.resourceType === binding.resourceType &&
                    value.resourceId === binding.resource.remoteId &&
                    (value.provider !== 'subsplash' || value.account === binding.resource.account)
                )
              )
                return fail();
            }
          )
        );
      }
    }
    // No read follows these closures: original transport, reservations, and media admission stop atomically.
    source.commit();
    zero.commit();
    indexClosures.forEach((commit) => commit());
    if (!source.alreadyStopped) {
      tx.update(deps.firestore.doc(`temporalMediaState/${source.sermonId}`), {
        deletionParentRef: FieldValue.delete(),
      });
      tx.delete(deps.firestore.doc(`temporalMediaDeletionEffects/${ref.jobId}`));
      tx.set(deps.firestore.doc(source.sourceEvidence.path), {
        ...source.identity,
        state: 'stopped',
        stoppedAtMillis: Date.now(),
      });
    }
  });
  return {
    state: 'completed',
    mode: 'partial_stop',
    providerEffects: 'not_started',
    contentPreserved: true,
    planId: operation.planId,
    sessionId: operation.sessionId,
  };
}
