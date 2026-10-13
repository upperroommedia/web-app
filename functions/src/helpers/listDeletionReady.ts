import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldPath, type Firestore, type Transaction, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { LIST_DELETION_MIRROR_PLANS, type ListDeletionMirrorPlan } from './listDeletionMirrors';
import {
  desiredProviderDeletionDocumentFingerprint,
  desiredProviderDeletionIntentFingerprint,
} from '../../../packages/orchestration/src/provider-usage';
import {
  acknowledgedProjectionDigest as hash,
  ACKNOWLEDGED_PROJECTION_PLANS,
  assertAcknowledgedProjectionRequestPrepared,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import { providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import { publishingMutationRequestFingerprint } from '../temporal/publishing/durableOperationContext';
import {
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
  type ProviderMutationClosedEvidenceSeal,
  type ProviderMutationReadyCanonicalCompletion,
} from '../temporal/publishing/providerMutationGuard';

export const LIST_DELETION_READY = 'temporalListDeletionReady';
export interface ListDeletionReadyRunner {
  commitCurrent<T>(ref: DurableJobRef, fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => {
  throw new Error('LIST_DELETION_READY_PROOF_INVALID');
};
const identity = (header: Record<string, any>) =>
  hash({
    projectId: header.projectId,
    jobId: header.jobId,
    entity: header.entity,
    generation: header.generation,
    actorUid: header.actorUid,
    workflowId: header.workflowId,
    intentFingerprint: header.intentFingerprint,
    scopeFingerprint: header.scopeFingerprint,
    operation: header.operation,
  });
const sourceProgram = (header: Record<string, any>) =>
  hash({
    headerDigest: identity(header),
    inventoryDigest: header.inventoryDigest,
    scopeFingerprint: header.scopeFingerprint,
  });

async function readSource(tx: Transaction, db: Firestore, ref: DurableJobRef, plan: ListDeletionMirrorPlan) {
  if (
    !plan.planId ||
    plan.jobId !== ref.jobId ||
    plan.projectId !== ref.projectId ||
    firebaseAdmin.app().options.projectId !== ref.projectId
  )
    fail();
  const local = db.doc(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`);
  const [headerDoc, intentDoc, jobDoc] = await Promise.all([
    tx.get(local),
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
  ]);
  const header = headerDoc.data(),
    intent = intentDoc.data();
  if (
    !header ||
    !intent ||
    intent.kind !== 'list.delete' ||
    intent.entity?.type !== 'list' ||
    header.state !== 'prepared' ||
    header.projectId !== ref.projectId ||
    header.jobId !== ref.jobId ||
    header.generation !== intent.generation ||
    header.actorUid !== intent.actorUid ||
    header.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    hash(header.entity) !== hash(intent.entity) ||
    header.scopeFingerprint !== desiredProviderDeletionDocumentFingerprint(plan) ||
    hash(header.plan) !== hash(plan) ||
    jobDoc.get('generation') !== intent.generation ||
    jobDoc.get('projectId') !== ref.projectId ||
    jobDoc.get('jobId') !== ref.jobId ||
    jobDoc.get('kind') !== intent.kind ||
    jobDoc.get('workflowId') !== header.workflowId ||
    hash(jobDoc.get('entity')) !== hash(intent.entity)
  )
    return fail();
  const headerDigest = identity(header),
    completion = header.completion,
    absence = header.providerAbsence,
    removal = header.rootRemoval;
  if (
    !Number.isSafeInteger(header.inventoryRevision) ||
    header.inventoryRevision < 1 ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !sha(header.inventoryDigest) ||
    !Number.isSafeInteger(header.inventoryCount) ||
    header.inventoryCount < 1 ||
    !completion ||
    completion.inventoryDigest !== header.inventoryDigest ||
    completion.inventoryCount !== header.inventoryCount ||
    completion.headerDigest !== headerDigest ||
    completion.providerAbsenceDigest !== hash(absence) ||
    completion.rootRemovalDigest !== hash(removal) ||
    !absence ||
    absence.headerDigest !== headerDigest ||
    !removal ||
    removal.entityId !== intent.entity.id ||
    removal.headerDigest !== headerDigest ||
    removal.inventoryDigest !== header.inventoryDigest ||
    removal.providerAbsenceDigest !== hash(absence)
  )
    return fail();
  if ((await tx.get(db.doc(`lists/${intent.entity.id}`))).exists) fail();
  const scope = { projectId: ref.projectId, jobId: ref.jobId, operation: header.operation };
  if (typeof scope.operation !== 'string' || !scope.operation) fail();
  const sessionId = providerMutationFingerprint(scope),
    held = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
  if (
    !held.exists ||
    !['active', 'committed'].includes(held.get('state')) ||
    hash(held.get('scope')) !== hash(scope) ||
    !Array.isArray(held.get('resources')) ||
    held.get('effectsClosed') !== true ||
    held.get('effectsClosedClaimSetDigestVersion') !== 2 ||
    !sha(held.get('effectsClosedClaimSetDigest')) ||
    held.get('effectsClosedActualRequestCount') !== plan.remoteListIds.length
  )
    fail();
  const session: ProviderMutationSession = { db, id: sessionId, scope, resources: held.get('resources') };
  const projection = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`));
  if (
    !projection.exists ||
    projection.get('projectId') !== ref.projectId ||
    projection.get('jobId') !== ref.jobId ||
    projection.get('operation') !== header.operation ||
    projection.get('intentFingerprint') !== hash(intent) ||
    projection.get('requestCount') !== plan.remoteListIds.length
  )
    fail();
  let sourceRootDigest = hash(projection.data());
  if (
    sourceRootDigest !== absence.sourceRootDigest &&
    held.get('state') === 'committed' &&
    projection.get('completesActivity') === true
  ) {
    const historical = { ...projection.data(), completesActivity: false };
    if (hash(historical) === absence.sourceRootDigest) sourceRootDigest = absence.sourceRootDigest;
  }
  if (sourceRootDigest !== absence.sourceRootDigest) fail();
  const binding = {
    ...ref,
    planId: plan.planId,
    sessionId,
    headerDigest,
    intentFingerprint: hash(intent),
    generation: intent.generation,
    sourceProgramDigest: sourceProgram(header),
    sourceRootDigest,
    completionDigest: hash(completion),
    sessionScopeDigest: hash({ scope, resources: session.resources }),
    inventoryDigest: header.inventoryDigest,
    inventoryCount: header.inventoryCount,
  };
  return { local, header, session, held, binding, id: hash(binding) };
}

/** Streams immutable original completions and the completed canonical inventory under the caller's SDK fence. */
export async function prepareListDeletionReady(
  db: Firestore,
  ref: DurableJobRef,
  plan: ListDeletionMirrorPlan,
  runner: ListDeletionReadyRunner
): Promise<void> {
  let done = false;
  while (!done)
    done = await runner.commitCurrent(ref, async (tx) => {
      const source = await readSource(tx, db, ref, plan),
        rootRef = db.doc(`${LIST_DELETION_READY}/${source.id}`),
        saved = await tx.get(rootRef);
      let root: Record<string, any> = saved.exists
        ? saved.data()!
        : {
            schemaVersion: 1,
            ...source.binding,
            phase: 'requests',
            requestCount: 0,
            terminalClaimSetDigest: providerMutationClaimSetSeed(source.session.id),
            requestEvidenceDigest: hash([]),
            rowCount: 0,
            rowDigest: hash([]),
            completedDigest: hash([]),
          };
      if (
        root.schemaVersion !== 1 ||
        Object.entries(source.binding).some(([key, value]) => hash(root[key]) !== hash(value))
      )
        fail();
      if (root.phase === 'ready') return true;
      if (root.phase === 'requests') {
        let query = db
          .doc(`${PROVIDER_MUTATION_SESSIONS}/${source.session.id}`)
          .collection('requests')
          .orderBy(FieldPath.documentId())
          .limit(32);
        if (root.requestCursor) query = query.startAfter(root.requestCursor);
        const page = await tx.get(query);
        for (const request of page.docs) {
          const planned = await tx.get(
            db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${source.session.id}/requestIndex/${request.id}`)
          );
          const target = planned.get('request.target'),
            remoteId = target?.resourceId;
          if (
            target?.provider !== 'subsplash' ||
            target.account !== 'app:9XTSHD' ||
            target.resourceType !== 'list' ||
            !plan.remoteListIds.includes(remoteId)
          )
            fail();
          const payload = { id: remoteId },
            step = `delete-logical-list:${remoteId}:${providerPayloadFingerprint(payload)}`,
            fingerprint = publishingMutationRequestFingerprint({ method: 'DELETE', target, payload });
          if (
            request.id !== providerMutationFingerprint(step) ||
            request.get('step') !== step ||
            request.get('method') !== 'DELETE' ||
            request.get('fingerprint') !== fingerprint
          )
            fail();
          await assertAcknowledgedProjectionRequestPrepared(tx, source.session, {
            step,
            method: 'DELETE',
            target,
            fingerprint,
          });
          await validateProviderMutationOriginalCompletion(tx, source.session, [request as QueryDocumentSnapshot]);
          const fact = await tx.get(
            db.doc(
              `${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([
                source.session.id,
                step,
                request.get('claim'),
              ])}`
            )
          );
          const state = request.get('state');
          if (state === 'rejected_no_effect') {
            const evidence = fact.get('evidence');
            if (
              evidence?.transport !== 'original_http_response' ||
              ![404, 410].includes(evidence.status) ||
              evidence.providerCode !== 'resource_not_found'
            )
              fail();
          } else if (state !== 'acknowledged') fail();
          root.terminalClaimSetDigest = providerMutationClaimSetFold(root.terminalClaimSetDigest, {
            requestId: request.id,
            step,
            method: 'DELETE',
            fingerprint,
            claim: request.get('claim'),
            executionId: request.get('executionId'),
            state,
          });
          root.requestEvidenceDigest = hash([
            root.requestEvidenceDigest,
            request.id,
            hash(request.data()),
            hash(fact.data()),
          ]);
          root.requestCount++;
        }
        if (page.size === 32) root.requestCursor = page.docs[31].id;
        else {
          if (root.requestCount !== plan.remoteListIds.length) fail();
          root.phase = 'rows';
        }
      } else if (root.phase === 'rows') {
        let query = source.local.collection('rows').orderBy(FieldPath.documentId()).limit(32);
        if (root.rowCursor) query = query.startAfter(root.rowCursor);
        const page = await tx.get(query);
        const completed = page.empty
          ? []
          : await tx.getAll(...page.docs.map((row) => source.local.collection('completedRows').doc(row.id)));
        const canonical = page.empty
          ? []
          : await tx.getAll(...page.docs.map((row) => db.doc(row.get('canonicalPath'))));
        page.docs.forEach((row, index) => {
          const expected = {
            canonicalPath: row.get('canonicalPath'),
            rowDigest: hash(row.data()),
            inventoryDigest: source.header.inventoryDigest,
            headerDigest: source.binding.headerDigest,
          };
          if (!completed[index].exists || hash(completed[index].data()) !== hash(expected) || canonical[index].exists)
            fail();
          root.rowDigest = hash([root.rowDigest, row.id, row.data()]);
          root.completedDigest = hash([root.completedDigest, row.id, completed[index].data()]);
          root.rowCount++;
        });
        if (page.size === 32) root.rowCursor = page.docs[31].id;
        else {
          if (root.rowCount !== source.header.inventoryCount || root.rowDigest !== source.header.inventoryDigest)
            fail();
          root.phase = 'ready';
        }
      } else fail();
      tx.set(rootRef, root);
      return root.phase === 'ready';
    });
}

/** A tiny immutable READY record independently proves the actual closure and all canonical inventory rows. */
export async function readListDeletionReadyCompletion(
  tx: Transaction,
  db: Firestore,
  plan: ListDeletionMirrorPlan,
  session: ProviderMutationSession,
  seal: ProviderMutationClosedEvidenceSeal
): Promise<ProviderMutationReadyCanonicalCompletion> {
  const ref = { projectId: plan.projectId, jobId: plan.jobId! },
    source = await readSource(tx, db, ref, plan),
    ready = await tx.get(db.doc(`${LIST_DELETION_READY}/${source.id}`));
  if (
    !ready.exists ||
    ready.get('schemaVersion') !== 1 ||
    ready.get('phase') !== 'ready' ||
    Object.entries(source.binding).some(([key, value]) => hash(ready.get(key)) !== hash(value)) ||
    source.session.id !== session.id ||
    seal.sessionId !== session.id ||
    seal.claimSetDigestVersion !== 2 ||
    source.held.get('effectsClosedClaimSetDigest') !== seal.claimSetDigest ||
    source.held.get('effectsClosedActualRequestCount') !== seal.actualRequestCount ||
    ready.get('terminalClaimSetDigest') !== seal.claimSetDigest ||
    ready.get('requestCount') !== seal.actualRequestCount ||
    ready.get('requestCount') !== plan.remoteListIds.length ||
    ready.get('rowCount') !== source.header.inventoryCount ||
    ready.get('rowDigest') !== source.header.inventoryDigest ||
    !sha(ready.get('completedDigest')) ||
    !sha(ready.get('requestEvidenceDigest')) ||
    !sha(seal.claimSetDigest)
  )
    fail();
  return {
    closedClaimSetDigest: ready.get('terminalClaimSetDigest'),
    originalRequestCount: ready.get('requestCount'),
    immutableCatalogDigest: hash([
      source.binding.sourceProgramDigest,
      source.binding.sourceRootDigest,
      ready.get('requestEvidenceDigest'),
      ready.get('rowDigest'),
    ]),
    canonicalCompletionDigest: hash([
      ready.get('completedDigest'),
      ready.get('rowCount'),
      source.binding.completionDigest,
    ]),
    expectedCanonicalPageCount: source.header.inventoryCount,
    completedCanonicalPageCount: ready.get('rowCount'),
  };
}
