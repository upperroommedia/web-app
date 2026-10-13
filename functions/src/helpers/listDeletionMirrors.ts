import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  FieldPath,
  type Firestore,
  type Transaction,
  type Query,
  type QueryDocumentSnapshot,
  type DocumentReference,
} from 'firebase-admin/firestore';
import {
  getDurablePublishingJobId,
  getPublishingMutationOperation,
  runDurableTransaction,
  prepareProviderMutationEffectsClosed as prepareDurableListEffectsClosed,
  prepareAcknowledgedProjectionPlan,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import type { DurableJobIntent, DurableActivityExecution } from '../../../packages/orchestration/src/job-store';
import {
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  prepareProviderMutationEffectsClosed as prepareCoreListEffectsClosed,
  validateProviderMutationOriginalCompletion,
  providerMutationFingerprint,
} from '../temporal/publishing/providerMutationGuard';
import { providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  assertAcknowledgedRepairCandidateVerificationSeal,
  assertAcknowledgedProjectionRequestPrepared,
  acknowledgedProjectionDigest,
  type FrozenProjectionRequest,
  type FrozenProjectionWrite,
  type AcknowledgedProviderObservation,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  desiredProviderDeletionPlanId,
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
  providerEdgeKey,
  extractProviderResources,
  type ProviderResource,
} from '../../../packages/orchestration/src/provider-usage';

export const LIST_DELETION_MIRROR_PLANS = 'temporalListDeletionMirrorPlans';
const REMOTE_PLANS = 'temporalProviderDesiredDeletionPlans';
const PAGE_SIZE = 200;
const DELETE_PAGE_SIZE = 64;
type Row = {
  canonicalPath: string;
  sourceFingerprint: string;
  expectedDocumentDigest?: string;
  kind?: 'mirror' | 'canonical';
};
export type ListDeletionMirrorInput = { rootListId: string; firestoreListIds: string[]; remoteListIds: string[] };
export type ListDeletionMirrorPlan = Readonly<
  ListDeletionMirrorInput & {
    projectId: string;
    jobId?: string;
    planId?: string;
    legacyRows?: readonly Row[];
  }
>;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
function fail(): never {
  throw new Error('LIST_DELETION_MIRROR_PROOF_INVALID');
}
const owned = (path: string, ids: Set<string>): boolean => {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'sermons' && parts[2] === 'sermonLists' && ids.has(parts[3]);
};
const canonicalOwned = (path: string, ids: Set<string>): boolean => {
  const parts = path.split('/');
  return (
    parts[0] === 'lists' &&
    ids.has(parts[1]) &&
    (parts.length === 2 || (parts.length === 4 && parts[2] === 'listItems'))
  );
};
const normalized = (input: ListDeletionMirrorInput): ListDeletionMirrorInput => {
  if (
    !validId(input.rootListId) ||
    !Array.isArray(input.firestoreListIds) ||
    !Array.isArray(input.remoteListIds) ||
    [...input.firestoreListIds, ...input.remoteListIds].some((id) => !validId(id))
  )
    return fail();
  const firestoreListIds = [...new Set(input.firestoreListIds)].sort();
  const remoteListIds = [...new Set(input.remoteListIds)].sort();
  if (!firestoreListIds.includes(input.rootListId)) return fail();
  return { rootListId: input.rootListId, firestoreListIds, remoteListIds };
};
const resource = (projectId: string, remoteId: string): ProviderResource => ({
  projectId,
  provider: 'subsplash',
  account: 'app:9XTSHD',
  remoteId,
});
const remotePlanRef = (db: Firestore, plan: ListDeletionMirrorPlan, remoteId: string) =>
  db.collection(REMOTE_PLANS).doc(
    desiredProviderDeletionPlanId({
      resource: resource(plan.projectId, remoteId),
      jobId: plan.jobId!,
      resourceType: 'list',
    })
  );
const transact = <T>(db: Firestore, durable: boolean, operation: (tx: Transaction) => Promise<T>): Promise<T> =>
  durable ? runDurableTransaction(db, operation) : db.runTransaction(operation);

const cleanupActivities = new Set([
  'executePublishingEntityActivity',
  'repairPublishingCritical',
  'cleanupCancelledPublishingEntity',
]);
const headerIdentity = (header: Record<string, unknown>) =>
  acknowledgedProjectionDigest({
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
function assertPrivateIntent(header: Record<string, any>, intent: DurableJobIntent<unknown>): void {
  if (
    header.state !== 'prepared' ||
    header.projectId !== intent.projectId ||
    header.jobId !== intent.jobId ||
    header.generation !== intent.generation ||
    header.actorUid !== intent.actorUid ||
    header.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    desiredProviderDeletionDocumentFingerprint(header.entity) !==
      desiredProviderDeletionDocumentFingerprint(intent.entity) ||
    !validId(intent.actorUid) ||
    !header.plan ||
    header.scopeFingerprint !== desiredProviderDeletionDocumentFingerprint(header.plan)
  )
    fail();
}

/** Source-only checkpoint: called after every authenticated fixed-route GET reports 404/410.
 * Fresh reads never resolve an unknown mutation: original immutable completions are required first.
 */
export async function recordListDeletionProviderAbsence(db: Firestore, plan: ListDeletionMirrorPlan): Promise<void> {
  if (!plan.jobId) return;
  if (!plan.planId || getDurablePublishingJobId() !== plan.jobId) return fail();
  const local = db.collection(LIST_DELETION_MIRROR_PLANS).doc(plan.planId);
  for (const remoteId of plan.remoteListIds)
    await runDurableTransaction(db, async (tx) => {
      const header = (await tx.get(local)).data();
      const intent = (await tx.get(db.doc(`durableJobIntents/${plan.jobId}`))).data() as DurableJobIntent<unknown>;
      if (!header || !intent) return fail();
      assertPrivateIntent(header, intent);
      const scope = { projectId: plan.projectId, jobId: plan.jobId!, operation: header.operation };
      if (typeof scope.operation !== 'string') return fail();
      const sessionId = providerMutationFingerprint(scope);
      const sessionDoc = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
      if (
        !sessionDoc.exists ||
        providerMutationFingerprint(sessionDoc.get('scope')) !== providerMutationFingerprint(scope)
      )
        return fail();
      const step = `delete-logical-list:${remoteId}:${providerPayloadFingerprint({ id: remoteId })}`;
      const request = await tx.get(
        db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(step)}`)
      );
      const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list',
        resourceId: remoteId,
      };
      if (
        !request.exists ||
        request.get('method') !== 'DELETE' ||
        request.get('fingerprint') !==
          publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: { id: remoteId } })
      )
        return fail();
      const session = { db, id: sessionId, scope, resources: sessionDoc.get('resources') };
      if (
        !Array.isArray(session.resources) ||
        !session.resources.some((item) => providerMutationFingerprint(item) === providerMutationFingerprint(target))
      )
        return fail();
      await assertAcknowledgedProjectionRequestPrepared(tx, session, {
        step,
        method: 'DELETE',
        target,
        fingerprint: request.get('fingerprint'),
      });
      await validateProviderMutationOriginalCompletion(tx, session, [request as QueryDocumentSnapshot]);
      const fact = await tx.get(
        db.doc(`${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, step, request.get('claim')])}`)
      );
      if (request.get('state') === 'rejected_no_effect') {
        const evidence = fact.get('evidence');
        if (
          evidence?.transport !== 'original_http_response' ||
          ![404, 410].includes(evidence.status) ||
          evidence.providerCode !== 'resource_not_found'
        )
          return fail();
      } else if (request.get('state') !== 'acknowledged') return fail();
      const row = local.collection('providerAbsences').doc(providerEdgeKey(remoteId));
      const prior = await tx.get(row);
      const proof = {
        remoteId,
        sessionId,
        requestFingerprint: request.get('fingerprint'),
        factDigest: acknowledgedProjectionDigest(fact.data()),
        headerDigest: headerIdentity(header),
      };
      if (prior.exists && acknowledgedProjectionDigest(prior.data()) !== acknowledgedProjectionDigest(proof))
        return fail();
      if (!prior.exists) tx.create(row, proof);
    });
  await runDurableTransaction(db, async (tx) => {
    const header = (await tx.get(local)).data();
    const intent = (await tx.get(db.doc(`durableJobIntents/${plan.jobId}`))).data() as DurableJobIntent<unknown>;
    if (!header || !intent) return fail();
    assertPrivateIntent(header, intent);
    // Page-sized proof reads avoid a document-count ceiling; only bounded hashes are stored in the header.
    let digest = acknowledgedProjectionDigest([]);
    for (let offset = 0; offset < plan.remoteListIds.length; offset += 64) {
      const rows = await tx.getAll(
        ...plan.remoteListIds
          .slice(offset, offset + 64)
          .map((id) => local.collection('providerAbsences').doc(providerEdgeKey(id)))
      );
      for (const row of rows) {
        if (!row.exists || row.get('headerDigest') !== headerIdentity(header)) return fail();
        digest = acknowledgedProjectionDigest([digest, row.data()]);
      }
    }
    const sessionId = providerMutationFingerprint({
      projectId: plan.projectId,
      jobId: plan.jobId,
      operation: header.operation,
    });
    const source = plan.remoteListIds.length
      ? (await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`))).data()
      : undefined;
    if (plan.remoteListIds.length && (!source || source.intentFingerprint !== header.intentFingerprint)) return fail();
    const proof = {
      headerDigest: headerIdentity(header),
      absenceDigest: digest,
      sourceRootDigest: source ? acknowledgedProjectionDigest(source) : headerIdentity(header),
      sessionId,
      localOnly: !plan.remoteListIds.length,
    };
    if (
      header.providerAbsence &&
      acknowledgedProjectionDigest(header.providerAbsence) !== acknowledgedProjectionDigest(proof)
    )
      return fail();
    if (!header.providerAbsence) tx.update(local, { providerAbsence: proof });
  });
}

/** Private missing-root exception, restricted to the original deletion intent and worker activity. */
export async function validateDeletedListCleanup(
  db: Firestore,
  intent: DurableJobIntent<unknown>,
  execution: DurableActivityExecution,
  tx?: Transaction
): Promise<{ ownerId?: string }> {
  const read = async (transaction: Transaction) => {
    if (
      firebaseAdmin.app().options.projectId !== intent.projectId ||
      intent.kind !== 'list.delete' ||
      intent.entity.type !== 'list' ||
      !cleanupActivities.has(execution.activityType)
    )
      return fail();
    const matches = await transaction.get(
      db
        .collection(LIST_DELETION_MIRROR_PLANS)
        .where('jobId', '==', intent.jobId)
        .where('entity.id', '==', intent.entity.id)
        .limit(2)
    );
    if (matches.size !== 1) return fail();
    const header = matches.docs[0].data();
    assertPrivateIntent(header, intent);
    const root = await transaction.get(db.doc(`lists/${intent.entity.id}`));
    const checkpoint = header.rootRemoval;
    if (
      root.exists ||
      header.workflowId !== execution.workflowId ||
      !checkpoint ||
      !header.providerAbsence ||
      checkpoint.entityId !== intent.entity.id ||
      checkpoint.headerDigest !== headerIdentity(header) ||
      checkpoint.providerAbsenceDigest !== acknowledgedProjectionDigest(header.providerAbsence)
    )
      return fail();
    const stored = await transaction.get(db.doc(`durableJobIntents/${intent.jobId}`));
    const job = await transaction.get(db.doc(`durableJobs/${intent.jobId}`));
    if (
      desiredProviderDeletionIntentFingerprint(stored.data()) !== header.intentFingerprint ||
      job.get('generation') !== intent.generation ||
      job.get('workflowId') !== execution.workflowId
    )
      return fail();
    const plan = header.plan as ListDeletionMirrorPlan;
    await factualListHeader(transaction, db, plan);
    await assertListProviderFacts(transaction, db, plan, header);
    return { ownerId: intent.actorUid };
  };
  return tx ? read(tx) : db.runTransaction(read);
}

/** The chain is reconstructed from current server documents, rather than trusting paths
 * supplied by a caller. Private intent identity is loaded inside the same fenced transaction.
 */
async function authority(tx: Transaction, db: Firestore, plan: ListDeletionMirrorPlan) {
  const root = await tx.get(db.doc(`lists/${plan.rootListId}`));
  if (!root.exists || (root.get('rootListId') && root.get('rootListId') !== plan.rootListId)) return fail();
  const locals = new Set<string>();
  const remotes = new Set<string>();
  let current = root;
  for (;;) {
    if (!current.exists || locals.has(current.id) || (current.id !== root.id && current.get('rootListId') !== root.id))
      return fail();
    locals.add(current.id);
    const remoteId = current.get('subsplashId');
    if (remoteId) {
      if (!validId(remoteId)) return fail();
      remotes.add(remoteId);
    }
    const next = current.get('moreSermonsRef');
    if (!next) break;
    if (!validId(next)) return fail();
    const mapped = await tx.get(db.collection('lists').where('subsplashId', '==', next).limit(2));
    if (mapped.size !== 1) return fail();
    current = mapped.docs[0];
  }
  if (
    JSON.stringify([...locals].sort()) !== JSON.stringify(plan.firestoreListIds) ||
    JSON.stringify([...remotes].sort()) !== JSON.stringify(plan.remoteListIds)
  )
    return fail();
  if (!plan.jobId) return undefined;
  const [intentSnapshot, jobSnapshot] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${plan.jobId}`)),
    tx.get(db.doc(`durableJobs/${plan.jobId}`)),
  ]);
  const intent = intentSnapshot.data();
  const job = jobSnapshot.data();
  if (
    !intent ||
    !job ||
    intent.projectId !== plan.projectId ||
    intent.jobId !== plan.jobId ||
    job.projectId !== intent.projectId ||
    job.jobId !== intent.jobId ||
    job.kind !== intent.kind ||
    job.generation !== intent.generation ||
    job.entity?.type !== intent.entity?.type ||
    job.entity?.id !== intent.entity?.id ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state)
  )
    return fail();
  const domain = intent.payload;
  if (
    domain?.kind !== intent.kind ||
    domain?.entity?.type !== intent.entity?.type ||
    domain?.entity?.id !== intent.entity?.id
  )
    return fail();
  const payload = domain.payload;
  const allowedList =
    intent.kind === 'list.delete' &&
    intent.entity?.type === 'list' &&
    locals.has(intent.entity?.id) &&
    payload?.operation === 'delete' &&
    (payload.input?.listId === undefined || payload.input?.listId === intent.entity?.id);
  let allowedSpeaker = false;
  if (
    intent.kind === 'speaker.mutate' &&
    intent.entity?.type === 'speaker' &&
    ['delete', 'update'].includes(payload?.operation) &&
    payload.input?.deleteAssociatedList === true &&
    payload.input?.speakerId === intent.entity.id
  ) {
    const speaker = await tx.get(db.doc(`speakers/${intent.entity.id}`));
    allowedSpeaker = locals.has(speaker.get('listId'));
  }
  if (!allowedList && !allowedSpeaker) return fail();
  return {
    entity: intent.entity,
    generation: intent.generation,
    actorUid: intent.actorUid,
    ...(typeof job.workflowId === 'string' ? { workflowId: job.workflowId } : {}),
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
  };
}

async function* pages(query: Query, optionalIndex = false): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const ordered = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    let page;
    try {
      page = await (cursor ? ordered.startAfter(cursor) : ordered).get();
    } catch (error) {
      if (
        optionalIndex &&
        ((error as { code?: unknown }).code === 9 || (error as { code?: unknown }).code === 'failed-precondition')
      )
        return;
      throw error;
    }
    if (page.empty) return;
    yield page.docs;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) return;
  }
}

async function freezeCanonicalDeletionProgram(db: Firestore, plan: ListDeletionMirrorPlan): Promise<void> {
  if (!plan.jobId || !plan.planId || !plan.remoteListIds.length) return;
  const operation = getPublishingMutationOperation();
  if (!operation) throw new Error('LIST_DELETION_MUTATION_PLAN_REQUIRED');
  const requests: FrozenProjectionRequest[] = plan.remoteListIds.map((remoteId) => {
    const target = {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId: remoteId,
    };
    const payload = { id: remoteId };
    return {
      step: `delete-logical-list:${remoteId}:${providerPayloadFingerprint(payload)}`,
      method: 'DELETE',
      target,
      payload,
      fingerprint: publishingMutationRequestFingerprint({ method: 'DELETE', target, payload }),
    };
  });
  const steps = requests.map((request) => request.step);
  const header = await db.doc(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`).get();
  const selectedRoot = header.get('entity.type') === 'list' ? `lists/${header.get('entity.id')}` : undefined;
  if (selectedRoot) {
    const row = (
      await db.doc(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}/rows/${providerEdgeKey(selectedRoot)}`).get()
    ).data() as Row | undefined;
    if (!row || row.canonicalPath !== selectedRoot || row.kind !== 'canonical' || !row.expectedDocumentDigest) fail();
    await runDurableTransaction(db, async (tx) => {
      const snapshot = await tx.get(db.doc(selectedRoot));
      if (!snapshot.exists || desiredProviderDeletionDocumentFingerprint(snapshot.data()) !== row.sourceFingerprint)
        fail();
      const frozen = await prepareAcknowledgedProjectionPlan(tx, {
        operation,
        requests,
        writes: [
          {
            path: selectedRoot,
            mode: 'delete',
            expectedExists: true,
            expectedDocumentDigest: row.expectedDocumentDigest,
            expectedFields: {},
            patch: {},
            requiredSteps: steps,
          },
        ],
        completesActivity: false,
        finalFragment: false,
        verifications: requests.map((request) => ({
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'list',
          resourceId: request.target!.resourceId,
          expectedState: 'absent',
          expectedProviderFields: {},
          requiredSteps: steps,
        })),
      });
      frozen.commit();
    });
  }
  for await (const page of pages(db.collection(LIST_DELETION_MIRROR_PLANS).doc(plan.planId).collection('rows'))) {
    for (let offset = 0; offset < page.length; offset += DELETE_PAGE_SIZE) {
      const records = page
        .slice(offset, offset + DELETE_PAGE_SIZE)
        .map((doc) => doc.data() as Row)
        .filter((row) => row.canonicalPath !== selectedRoot);
      if (!records.length) continue;
      const writes: FrozenProjectionWrite[] = records.map((row) => ({
        path: row.canonicalPath,
        mode: 'delete',
        expectedExists: true,
        expectedDocumentDigest: row.expectedDocumentDigest,
        expectedFields: {},
        patch: {},
        requiredSteps: steps,
      }));
      await runDurableTransaction(db, async (tx) => {
        const snapshots = await tx.getAll(...records.map((row) => db.doc(row.canonicalPath)));
        snapshots.forEach((snapshot, index) => {
          if (
            !snapshot.exists ||
            desiredProviderDeletionDocumentFingerprint(snapshot.data()) !== records[index].sourceFingerprint
          )
            return fail();
        });
        const frozen = await prepareAcknowledgedProjectionPlan(tx, {
          operation,
          requests,
          writes,
          completesActivity: false,
          finalFragment: false,
          verifications: requests.map((request) => ({
            provider: 'subsplash',
            account: 'app:9XTSHD',
            resourceType: 'list',
            resourceId: request.target!.resourceId,
            expectedState: 'absent',
            expectedProviderFields: {},
            requiredSteps: steps,
          })),
        });
        frozen.commit();
      });
    }
  }
  // Every deletion in the chain is a prerequisite for these logical-list removals.
  // Seal the same factual request set only after its entire row program is captured.
  await runDurableTransaction(db, async (tx) => {
    const sealed = await prepareAcknowledgedProjectionPlan(tx, {
      operation,
      requests,
      writes: [],
      verifications: [],
      finalFragment: true,
      completesActivity: false,
    });
    sealed.commit();
  });
}

/** Freeze every owned membership before any DELETE. The returned handle is private
 * worker state; no canonical row is removed during preparation.
 */
export async function prepareListDeletionMirrors(
  db: Firestore,
  raw: ListDeletionMirrorInput
): Promise<ListDeletionMirrorPlan> {
  const input = normalized(raw);
  const projectId = firebaseAdmin.app().options.projectId;
  if (!validId(projectId)) return fail();
  const jobId = getDurablePublishingJobId();
  const planId = jobId
    ? createHash('sha256')
        .update(JSON.stringify([projectId, jobId, input.rootListId]))
        .digest('hex')
    : undefined;
  const plan: ListDeletionMirrorPlan = { ...input, projectId, ...(jobId ? { jobId, planId } : {}) };
  const localRef = planId ? db.collection(LIST_DELETION_MIRROR_PLANS).doc(planId) : undefined;
  const cached = localRef ? await localRef.get() : undefined;
  if (cached?.get('state') === 'prepared') {
    if (cached.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan)) return fail();
    // The caller's durable transaction fence remains mandatory when reusing the immutable plan.
    await runDurableTransaction(db, async (tx) => {
      const fresh = await tx.get(localRef!);
      if (fresh.get('state') !== 'prepared') return fail();
    });
    await freezeCanonicalDeletionProgram(db, plan);
    return plan;
  }
  await transact(db, !!jobId, async (tx) => {
    const scope = await authority(tx, db, plan);
    if (!localRef || !scope) return;
    const existing = await tx.get(localRef);
    const remoteRefs = input.remoteListIds.map((id) => remotePlanRef(db, plan, id));
    const remoteHeaders = remoteRefs.length ? await tx.getAll(...remoteRefs) : [];
    if (existing.exists && existing.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan))
      return fail();
    const headers = input.remoteListIds.map((remoteId) => ({
      schemaVersion: 1,
      projectId,
      jobId,
      resource: resource(projectId, remoteId),
      resourceType: 'list',
      ...scope,
      method: 'DELETE',
      requestFingerprint: providerMutationFingerprint(['DELETE', { id: remoteId }]),
      state: 'prepared',
    }));
    remoteHeaders.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      for (const key of Object.keys(headers[index]).filter((key) => key !== 'state'))
        if (
          desiredProviderDeletionDocumentFingerprint(snapshot.get(key)) !==
          desiredProviderDeletionDocumentFingerprint((headers[index] as Record<string, unknown>)[key])
        )
          return fail();
    });
    if (!existing.exists)
      tx.create(localRef, {
        schemaVersion: 1,
        projectId,
        jobId,
        rootListId: input.rootListId,
        ...scope,
        plan: { ...plan },
        ...(getPublishingMutationOperation() ? { operation: getPublishingMutationOperation() } : {}),
        scopeFingerprint: desiredProviderDeletionDocumentFingerprint(plan),
        inventoryRevision: 0,
        state: 'preparing',
      });
    remoteHeaders.forEach((snapshot, index) => {
      if (!snapshot.exists) tx.create(remoteRefs[index], headers[index]);
    });
  });
  const ids = new Set(input.firestoreListIds);
  const captured = new Map<string, Row>();
  // Every canonical row can require one local record plus one record per target.
  // Keep preparation below the write limit even when a mirror references many pages.
  const capturePageSize = Math.max(1, Math.min(DELETE_PAGE_SIZE, Math.floor(400 / (input.remoteListIds.length + 1))));
  const capture = async (candidates: QueryDocumentSnapshot[]) => {
    const paths = candidates
      .map((doc) => doc.ref.path)
      .filter((path) => (owned(path, ids) || canonicalOwned(path, ids)) && !captured.has(path));
    for (let offset = 0; offset < paths.length; offset += capturePageSize) {
      const chunk = paths.slice(offset, offset + capturePageSize);
      await transact(db, !!jobId, async (tx) => {
        if (jobId) await authority(tx, db, plan);
        const captureHeader = localRef ? await tx.get(localRef) : undefined;
        if (
          captureHeader &&
          (captureHeader.get('state') !== 'preparing' ||
            captureHeader.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan))
        )
          return fail();
        const snapshots = await tx.getAll(...chunk.map((path) => db.doc(path)));
        const rows = snapshots
          .filter((snapshot) => snapshot.exists)
          .map((snapshot) => ({
            canonicalPath: snapshot.ref.path,
            sourceFingerprint: desiredProviderDeletionDocumentFingerprint(snapshot.data()),
            expectedDocumentDigest: acknowledgedProjectionDigest(snapshot.data()),
            kind: snapshot.ref.path.startsWith('lists/') ? ('canonical' as const) : ('mirror' as const),
            snapshot,
          }));
        const prepared: Array<{
          ref: ReturnType<Firestore['doc']>;
          record: Row & { after?: 'absent' };
          exists: boolean;
        }> = [];
        for (const row of rows) {
          const refs = localRef ? [localRef.collection('rows').doc(providerEdgeKey(row.canonicalPath))] : [];
          if (localRef) {
            const referenced = new Set(
              extractProviderResources(projectId, row.canonicalPath, row.snapshot.data()).map((entry) => entry.remoteId)
            );
            for (const remoteId of input.remoteListIds)
              if (referenced.has(remoteId))
                refs.push(
                  remotePlanRef(db, plan, remoteId).collection('removals').doc(providerEdgeKey(row.canonicalPath))
                );
          }
          const prior = refs.length ? await tx.getAll(...refs) : [];
          for (let index = 0; index < refs.length; index++) {
            const record = {
              canonicalPath: row.canonicalPath,
              sourceFingerprint: row.sourceFingerprint,
              ...(index
                ? { after: 'absent' as const }
                : { expectedDocumentDigest: row.expectedDocumentDigest, kind: row.kind }),
            };
            if (
              prior[index].exists &&
              (prior[index].get('canonicalPath') !== row.canonicalPath ||
                prior[index].get('sourceFingerprint') !== row.sourceFingerprint)
            )
              return fail();
            prepared.push({ ref: refs[index], record, exists: prior[index].exists });
          }
        }
        // Every canonical and prior-plan read finishes before the first private-plan write.
        prepared.forEach((entry) => {
          if (!entry.exists) tx.create(entry.ref, entry.record);
        });
        if (
          localRef &&
          captureHeader &&
          prepared.some((entry) => !entry.exists && entry.ref.path.startsWith(`${localRef.path}/rows/`))
        )
          tx.update(localRef, { inventoryRevision: (captureHeader.get('inventoryRevision') ?? 0) + 1 });
        rows.forEach(({ canonicalPath, sourceFingerprint }) =>
          captured.set(canonicalPath, { canonicalPath, sourceFingerprint })
        );
      });
    }
  };
  // The deletion program includes the actual physical list documents and memberships.
  // Unrecognized descendant collections must be handled by a future explicit proof program.
  for (const listId of input.firestoreListIds) {
    const ref = db.collection('lists').doc(listId);
    if (jobId && (await ref.listCollections()).some((collection) => collection.id !== 'listItems'))
      throw new Error('LIST_DELETION_ACK_DESCENDANT_PROGRAM_REQUIRED');
    const snapshot = await ref.get();
    if (snapshot.exists) await capture([snapshot as QueryDocumentSnapshot]);
    for await (const page of pages(ref.collection('listItems'))) {
      if (jobId)
        for (const doc of page)
          if ((await doc.ref.listCollections()).length)
            throw new Error('LIST_DELETION_ACK_DESCENDANT_PROGRAM_REQUIRED');
      await capture(page);
    }
  }
  // Indexed candidate reads speed up common records. The document ID check is the
  // authority: copied data.id or provider IDs never authorize deleting another list.
  for (const [field, values] of [
    ['id', input.firestoreListIds],
    ['subsplashId', input.remoteListIds],
  ] as const) {
    for (const value of values) {
      // Only candidate-query index failures fall back; a failed canonical fence or
      // fingerprint check in capture must never be swallowed as an index issue.
      for await (const page of pages(db.collectionGroup('sermonLists').where(field, '==', value), true))
        await capture(page);
    }
  }
  // Legacy mirrors can lack both fields. Scan in bounded pages with no total fleet ceiling.
  for await (const page of pages(db.collectionGroup('sermonLists'))) await capture(page);
  if (localRef) {
    const before = await localRef.get();
    let inventoryDigest = acknowledgedProjectionDigest([]),
      inventoryCount = 0;
    for await (const page of pages(localRef.collection('rows')))
      for (const row of page) {
        inventoryDigest = acknowledgedProjectionDigest([inventoryDigest, row.id, row.data()]);
        inventoryCount++;
      }
    await runDurableTransaction(db, async (tx) => {
      await authority(tx, db, plan);
      const current = await tx.get(localRef);
      if (
        !current.exists ||
        current.get('state') !== 'preparing' ||
        current.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan) ||
        current.get('inventoryRevision') !== before.get('inventoryRevision')
      )
        return fail();
      tx.update(localRef, { state: 'prepared', inventoryDigest, inventoryCount });
    });
  }
  await freezeCanonicalDeletionProgram(db, plan);
  return localRef
    ? plan
    : { ...plan, legacyRows: [...captured.values()].filter((row) => owned(row.canonicalPath, ids)) };
}

/** Invoke only after all corresponding provider DELETEs establish authoritative absence.
 * Changed canonical rows fail closed; missing rows are an idempotent success.
 */
export async function removeListDeletionMirrors(db: Firestore, plan: ListDeletionMirrorPlan): Promise<void> {
  const expected = getDurablePublishingJobId();
  if (plan.jobId !== expected || firebaseAdmin.app().options.projectId !== plan.projectId) return fail();
  const ids = new Set(plan.firestoreListIds);
  const remove = async (rows: Row[]) => {
    for (let offset = 0; offset < rows.length; offset += DELETE_PAGE_SIZE) {
      const chunk = rows.slice(offset, offset + DELETE_PAGE_SIZE);
      if (chunk.some((row) => !owned(row.canonicalPath, ids))) return fail();
      await transact(db, !!plan.jobId, async (tx) => {
        if (plan.jobId) {
          const header = await tx.get(db.collection(LIST_DELETION_MIRROR_PLANS).doc(plan.planId!));
          const [intentSnapshot, jobSnapshot] = await Promise.all([
            tx.get(db.doc(`durableJobIntents/${plan.jobId}`)),
            tx.get(db.doc(`durableJobs/${plan.jobId}`)),
          ]);
          const intent = intentSnapshot.data(),
            job = jobSnapshot.data();
          if (
            header.get('state') !== 'prepared' ||
            header.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan) ||
            !intent ||
            !job ||
            intent.projectId !== plan.projectId ||
            intent.jobId !== plan.jobId ||
            job.projectId !== intent.projectId ||
            job.jobId !== intent.jobId ||
            job.kind !== intent.kind ||
            job.generation !== intent.generation ||
            header.get('generation') !== intent.generation ||
            desiredProviderDeletionIntentFingerprint(intent) !== header.get('intentFingerprint') ||
            desiredProviderDeletionDocumentFingerprint(header.get('entity')) !==
              desiredProviderDeletionDocumentFingerprint(intent.entity) ||
            desiredProviderDeletionDocumentFingerprint(job.entity) !==
              desiredProviderDeletionDocumentFingerprint(intent.entity) ||
            !['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state)
          )
            return fail();
          if (!header.get('providerAbsence')) return fail();
          if (intent.kind === 'list.delete') {
            const selectedRoot = await tx.get(db.doc(`lists/${intent.entity.id}`));
            if (!selectedRoot.exists) {
              const checkpoint = header.get('rootRemoval');
              if (
                !checkpoint ||
                checkpoint.entityId !== intent.entity.id ||
                checkpoint.headerDigest !== headerIdentity(header.data()!) ||
                checkpoint.providerAbsenceDigest !== acknowledgedProjectionDigest(header.get('providerAbsence'))
              )
                return fail();
            }
          }
          // This proof deliberately does not depend on the now-deleted canonical root.
          // Current actor authority and generation are additionally checked by the SDK fence.
        }
        const snapshots = await tx.getAll(...chunk.map((row) => db.doc(row.canonicalPath)));
        snapshots.forEach((snapshot, index) => {
          if (
            snapshot.exists &&
            desiredProviderDeletionDocumentFingerprint(snapshot.data()) !== chunk[index].sourceFingerprint
          )
            return fail();
        });
        snapshots.forEach((snapshot) => {
          if (snapshot.exists) tx.delete(snapshot.ref);
        });
      });
    }
  };
  if (plan.jobId) {
    if (!plan.planId) return fail();
    const local = db.collection(LIST_DELETION_MIRROR_PLANS).doc(plan.planId);
    const header = await local.get();
    if (
      header.get('state') !== 'prepared' ||
      header.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan)
    )
      return fail();
    for await (const page of pages(local.collection('rows')))
      await remove(page.map((doc) => doc.data() as Row).filter((row) => owned(row.canonicalPath, ids)));
  } else await remove([...(plan.legacyRows ?? [])]);
}

/** Canonical subtree pages must match the preclaim ledger too. A newly-created or
 * edited child is not silently swept up by recursive deletion after the provider ACK.
 */
export async function deleteListDeletionCanonicalPage(
  db: Firestore,
  plan: ListDeletionMirrorPlan,
  refs: readonly DocumentReference[]
): Promise<void> {
  if (!plan.jobId || !plan.planId || getDurablePublishingJobId() !== plan.jobId) return fail();
  const ids = new Set(plan.firestoreListIds);
  if (refs.some((ref) => !canonicalOwned(ref.path, ids))) return fail();
  for (let offset = 0; offset < refs.length; offset += DELETE_PAGE_SIZE) {
    const chunk = refs.slice(offset, offset + DELETE_PAGE_SIZE);
    await runDurableTransaction(db, async (tx) => {
      const local = db.collection(LIST_DELETION_MIRROR_PLANS).doc(plan.planId!);
      const header = await tx.get(local);
      if (
        header.get('state') !== 'prepared' ||
        header.get('scopeFingerprint') !== desiredProviderDeletionDocumentFingerprint(plan)
      )
        return fail();
      const [snapshots, records] = await Promise.all([
        tx.getAll(...chunk),
        tx.getAll(...chunk.map((ref) => local.collection('rows').doc(providerEdgeKey(ref.path)))),
      ]);
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) return;
        if (
          !records[index].exists ||
          records[index].get('kind') !== 'canonical' ||
          records[index].get('canonicalPath') !== snapshot.ref.path ||
          records[index].get('sourceFingerprint') !== desiredProviderDeletionDocumentFingerprint(snapshot.data())
        )
          return fail();
      });
      const selected = header.get('entity');
      const deletingSelected =
        selected?.type === 'list' &&
        snapshots.some((snapshot) => snapshot.exists && snapshot.ref.path === `lists/${selected.id}`);
      if (!header.get('providerAbsence')) return fail();
      const effectsClosed =
        deletingSelected && plan.remoteListIds.length
          ? await prepareDurableListEffectsClosed(tx, {
              operation: header.get('operation'),
              validateSourceEffects: async (transaction, session) => {
                const source = (await transaction.get(local)).data();
                if (
                  !source ||
                  session.id !==
                    providerMutationFingerprint({
                      projectId: plan.projectId,
                      jobId: plan.jobId,
                      operation: source.operation,
                    })
                )
                  fail();
                assertInventory(source);
                await assertListProviderFacts(transaction, db, plan, source);
                return {
                  sourceProgramDigest: listEffectsProgramDigest(source),
                  expectedRequestSteps: listDeletionRequestSteps(plan),
                  qualifiedNoSendSteps: [],
                };
              },
            })
          : undefined;
      if (deletingSelected)
        tx.update(local, {
          rootRemoval: {
            entityId: selected.id,
            headerDigest: headerIdentity(header.data()!),
            inventoryDigest: header.get('inventoryDigest'),
            providerAbsenceDigest: acknowledgedProjectionDigest(header.get('providerAbsence')),
          },
        });
      effectsClosed?.commit();
      snapshots.forEach((snapshot) => {
        if (snapshot.exists) tx.delete(snapshot.ref);
      });
    });
  }
}

const digestString = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const listPlanRef = (db: Firestore, plan: ListDeletionMirrorPlan) =>
  db.doc(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`);
function assertInventory(header: Record<string, any>): void {
  if (
    !digestString(header.inventoryDigest) ||
    !Number.isSafeInteger(header.inventoryCount) ||
    header.inventoryCount < 1 ||
    !Number.isSafeInteger(header.inventoryRevision) ||
    header.inventoryRevision < 1
  )
    fail();
}
async function assertListProviderFacts(
  tx: Transaction,
  db: Firestore,
  plan: ListDeletionMirrorPlan,
  header: Record<string, any>,
  requireStoredAbsence = true
): Promise<
  Array<{ remoteId: string; sessionId: string; requestFingerprint: string; factDigest: string; headerDigest: string }>
> {
  const scope = { projectId: plan.projectId, jobId: plan.jobId!, operation: header.operation };
  if (requireStoredAbsence && header.providerAbsence?.candidateId) {
    const absence = header.providerAbsence;
    const verified = await assertAcknowledgedRepairCandidateVerificationSeal(tx, db, {
      ref: { projectId: plan.projectId, jobId: plan.jobId! },
      sessionId: absence.sessionId,
      candidateId: absence.candidateId,
      candidateDigest: absence.candidateDigest,
      projectionDigest: absence.sourceRootDigest,
      observationScope: absence.observationScope,
      requiredTargets: listDeletionTargets(plan),
      requireCurrentProgram: false,
      programId: absence.programId,
      programSealDigest: absence.programSealDigest,
    });
    if (
      absence.headerDigest !== headerIdentity(header) ||
      absence.localOnly !== false ||
      absence.absenceDigest !== verified.programSealDigest ||
      verified.seal.canonicalPath !== `lists/${header.entity.id}`
    )
      fail();
    return [];
  }
  if (typeof scope.operation !== 'string' || !scope.operation) fail();
  const sessionId = providerMutationFingerprint(scope);
  if (!plan.remoteListIds.length) {
    if (
      requireStoredAbsence &&
      (header.providerAbsence?.localOnly !== true || header.providerAbsence.headerDigest !== headerIdentity(header))
    )
      fail();
    return [];
  }
  const held = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
  if (
    !held.exists ||
    !['active', 'committed'].includes(held.get('state')) ||
    providerMutationFingerprint(held.get('scope')) !== providerMutationFingerprint(scope) ||
    !Array.isArray(held.get('resources'))
  )
    fail();
  const session = { db, id: sessionId, scope, resources: held.get('resources') };
  const unsettled = await tx.get(
    db
      .doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)
      .collection('requests')
      .where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable'])
      .limit(1)
  );
  if (unsettled.size) fail();
  const proof: Array<{
    remoteId: string;
    sessionId: string;
    requestFingerprint: string;
    factDigest: string;
    headerDigest: string;
  }> = [];
  for (const remoteId of plan.remoteListIds) {
    const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list',
        resourceId: remoteId,
      },
      payload = { id: remoteId };
    const step = `delete-logical-list:${remoteId}:${providerPayloadFingerprint(payload)}`,
      fingerprint = publishingMutationRequestFingerprint({ method: 'DELETE', target, payload });
    const request = await tx.get(
      db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(step)}`)
    );
    if (
      !request.exists ||
      request.get('step') !== step ||
      request.get('method') !== 'DELETE' ||
      request.get('fingerprint') !== fingerprint ||
      !session.resources.some(
        (resource: any) => providerMutationFingerprint(resource) === providerMutationFingerprint(target)
      )
    )
      fail();
    await assertAcknowledgedProjectionRequestPrepared(tx, session, { step, method: 'DELETE', target, fingerprint });
    await validateProviderMutationOriginalCompletion(tx, session, [request as QueryDocumentSnapshot]);
    const fact = await tx.get(
      db.doc(`${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, step, request.get('claim')])}`)
    );
    if (request.get('state') === 'rejected_no_effect') {
      const evidence = fact.get('evidence');
      if (
        evidence?.transport !== 'original_http_response' ||
        ![404, 410].includes(evidence.status) ||
        evidence.providerCode !== 'resource_not_found'
      )
        fail();
    } else if (request.get('state') !== 'acknowledged') fail();
    const row = {
      remoteId,
      sessionId,
      requestFingerprint: fingerprint,
      factDigest: acknowledgedProjectionDigest(fact.data()),
      headerDigest: headerIdentity(header),
    };
    if (requireStoredAbsence) {
      const stored = await tx.get(listPlanRef(db, plan).collection('providerAbsences').doc(providerEdgeKey(remoteId)));
      if (!stored.exists || acknowledgedProjectionDigest(stored.data()) !== acknowledgedProjectionDigest(row)) fail();
    }
    proof.push(row);
  }
  if (requireStoredAbsence) {
    let digest = acknowledgedProjectionDigest([]);
    for (const row of proof) digest = acknowledgedProjectionDigest([digest, row]);
    if (
      header.providerAbsence?.absenceDigest !== digest ||
      header.providerAbsence.headerDigest !== headerIdentity(header) ||
      header.providerAbsence.sessionId !== sessionId ||
      header.providerAbsence.localOnly !== false
    )
      fail();
  }
  return proof;
}
async function factualListHeader(
  tx: Transaction,
  db: Firestore,
  plan: ListDeletionMirrorPlan,
  requireMissingRoot = true
): Promise<{ header: Record<string, any>; intent: DurableJobIntent<unknown> }> {
  if (!plan.jobId || !plan.planId || firebaseAdmin.app().options.projectId !== plan.projectId) fail();
  const header = (await tx.get(listPlanRef(db, plan))).data(),
    intent = (await tx.get(db.doc(`durableJobIntents/${plan.jobId}`))).data() as DurableJobIntent<unknown>;
  if (
    !header ||
    !intent ||
    intent.kind !== 'list.delete' ||
    intent.entity.type !== 'list' ||
    header.scopeFingerprint !== desiredProviderDeletionDocumentFingerprint(plan)
  )
    return fail();
  assertPrivateIntent(header, intent);
  assertInventory(header);
  const job = await tx.get(db.doc(`durableJobs/${plan.jobId}`));
  if (
    !job.exists ||
    job.get('projectId') !== plan.projectId ||
    job.get('jobId') !== plan.jobId ||
    job.get('kind') !== intent.kind ||
    job.get('generation') !== intent.generation ||
    job.get('workflowId') !== header.workflowId ||
    desiredProviderDeletionDocumentFingerprint(job.get('entity')) !==
      desiredProviderDeletionDocumentFingerprint(intent.entity)
  )
    fail();
  const selected = await tx.get(db.doc(`lists/${intent.entity.id}`)),
    checkpoint = header.rootRemoval;
  if (
    requireMissingRoot &&
    (selected.exists ||
      !checkpoint ||
      checkpoint.entityId !== intent.entity.id ||
      checkpoint.headerDigest !== headerIdentity(header) ||
      checkpoint.inventoryDigest !== header.inventoryDigest ||
      !header.providerAbsence ||
      checkpoint.providerAbsenceDigest !== acknowledgedProjectionDigest(header.providerAbsence))
  )
    fail();
  if (requireMissingRoot && plan.remoteListIds.length) {
    const held = await tx.get(
      db.doc(
        `${PROVIDER_MUTATION_SESSIONS}/${providerMutationFingerprint({
          projectId: plan.projectId,
          jobId: plan.jobId,
          operation: header.operation,
        })}`
      )
    );
    if (held.get('effectsClosed') !== true) fail();
  }
  return { header, intent };
}
/** Reads only the original immutable deletion ledger after an atomically certified root removal. Never invokes a provider. */
export async function loadFactualListDeletionCleanup(
  db: Firestore,
  ref: DurableJobRef,
  intent: DurableJobIntent<unknown>
): Promise<{ plan: ListDeletionMirrorPlan; remainingCanonicalRefs: DocumentReference[] }> {
  if (
    ref.projectId !== intent.projectId ||
    ref.jobId !== intent.jobId ||
    intent.kind !== 'list.delete' ||
    intent.entity.type !== 'list'
  )
    fail();
  const matches = await db
    .collection(LIST_DELETION_MIRROR_PLANS)
    .where('jobId', '==', ref.jobId)
    .where('entity.id', '==', intent.entity.id)
    .limit(2)
    .get();
  if (matches.size !== 1) fail();
  const stored = matches.docs[0].get('plan') as ListDeletionMirrorPlan;
  if (
    !stored ||
    stored.projectId !== ref.projectId ||
    stored.jobId !== ref.jobId ||
    stored.planId !== matches.docs[0].id
  )
    fail();
  const plan = { ...normalized(stored), projectId: stored.projectId, jobId: stored.jobId, planId: stored.planId };
  const { header } = await db.runTransaction(async (tx) => {
    const proof = await factualListHeader(tx, db, plan);
    if (desiredProviderDeletionIntentFingerprint(proof.intent) !== desiredProviderDeletionIntentFingerprint(intent))
      fail();
    await assertListProviderFacts(tx, db, plan, proof.header);
    return proof;
  });
  const ids = new Set(plan.firestoreListIds),
    remainingCanonicalRefs: DocumentReference[] = [],
    captured = new Set<string>();
  let digest = acknowledgedProjectionDigest([]),
    count = 0;
  for await (const page of pages(listPlanRef(db, plan).collection('rows'))) {
    for (const record of page) {
      digest = acknowledgedProjectionDigest([digest, record.id, record.data()]);
      count++;
      const row = record.data() as Row;
      if (
        (!canonicalOwned(row.canonicalPath, ids) && !owned(row.canonicalPath, ids)) ||
        !digestString(row.sourceFingerprint) ||
        !digestString(row.expectedDocumentDigest)
      )
        fail();
      captured.add(row.canonicalPath);
    }
    for (let offset = 0; offset < page.length; offset += DELETE_PAGE_SIZE)
      await db.runTransaction(async (tx) => {
        const current = await factualListHeader(tx, db, plan);
        if (current.header.inventoryDigest !== header.inventoryDigest) fail();
        const records = page.slice(offset, offset + DELETE_PAGE_SIZE),
          snapshots = await tx.getAll(...records.map((row) => db.doc(row.get('canonicalPath'))));
        snapshots.forEach((snapshot, index) => {
          if (
            snapshot.exists &&
            acknowledgedProjectionDigest(snapshot.data()) !== records[index].get('expectedDocumentDigest')
          )
            fail();
          if (snapshot.exists && canonicalOwned(snapshot.ref.path, ids)) remainingCanonicalRefs.push(snapshot.ref);
        });
      });
  }
  if (digest !== header.inventoryDigest || count !== header.inventoryCount) fail();
  // A newly-created descendant cannot be swept up by the frozen factual continuation.
  for (const id of plan.firestoreListIds) {
    const root = db.doc(`lists/${id}`);
    if ((await root.get()).exists && !captured.has(root.path)) fail();
    for await (const page of pages(root.collection('listItems')))
      for (const row of page) if (!captured.has(row.ref.path)) fail();
  }
  return { plan, remainingCanonicalRefs };
}
/** Capture completion of the immutable row ledger in bounded SDK-fenced transactions before final session release. */
export async function sealListDeletionCompletion(db: Firestore, plan: ListDeletionMirrorPlan): Promise<void> {
  if (getDurablePublishingJobId() !== plan.jobId) fail();
  const suppliedIntent = (await db.doc(`durableJobIntents/${plan.jobId}`).get()).data() as DurableJobIntent<unknown>;
  const cleanup = await loadFactualListDeletionCleanup(
    db,
    { projectId: plan.projectId, jobId: plan.jobId! },
    suppliedIntent
  );
  if (cleanup.remainingCanonicalRefs.length) fail();
  const initial = await db.runTransaction(async (tx) => {
    const proof = await factualListHeader(tx, db, plan);
    await assertListProviderFacts(tx, db, plan, proof.header);
    return proof;
  });
  const local = listPlanRef(db, plan);
  let digest = acknowledgedProjectionDigest([]),
    count = 0;
  for await (const page of pages(local.collection('rows'))) {
    for (const row of page) {
      digest = acknowledgedProjectionDigest([digest, row.id, row.data()]);
      count++;
    }
    for (let offset = 0; offset < page.length; offset += DELETE_PAGE_SIZE)
      await runDurableTransaction(db, async (tx) => {
        const { header } = await factualListHeader(tx, db, plan);
        if (header.inventoryDigest !== initial.header.inventoryDigest) fail();
        const rows = page.slice(offset, offset + DELETE_PAGE_SIZE),
          snapshots = await tx.getAll(...rows.map((row) => db.doc(row.get('canonicalPath'))));
        if (snapshots.some((snapshot) => snapshot.exists)) fail();
        const refs = rows.map((row) => local.collection('completedRows').doc(row.id)),
          completed = await tx.getAll(...refs);
        const records = rows.map((row) => ({
          canonicalPath: row.get('canonicalPath'),
          rowDigest: acknowledgedProjectionDigest(row.data()),
          inventoryDigest: header.inventoryDigest,
          headerDigest: headerIdentity(header),
        }));
        completed.forEach((snapshot, index) => {
          if (
            snapshot.exists &&
            acknowledgedProjectionDigest(snapshot.data()) !== acknowledgedProjectionDigest(records[index])
          )
            fail();
        });
        completed.forEach((snapshot, index) => {
          if (!snapshot.exists) tx.create(refs[index], records[index]);
        });
      });
  }
  if (digest !== initial.header.inventoryDigest || count !== initial.header.inventoryCount) fail();
  await runDurableTransaction(db, async (tx) => {
    const { header } = await factualListHeader(tx, db, plan);
    if (header.inventoryDigest !== digest || header.inventoryCount !== count) fail();
    const completion = {
      inventoryDigest: digest,
      inventoryCount: count,
      headerDigest: headerIdentity(header),
      providerAbsenceDigest: acknowledgedProjectionDigest(header.providerAbsence),
      rootRemovalDigest: acknowledgedProjectionDigest(header.rootRemoval),
    };
    if (
      header.completion &&
      acknowledgedProjectionDigest(header.completion) !== acknowledgedProjectionDigest(completion)
    )
      fail();
    if (!header.completion) tx.update(local, { completion });
  });
}
/** This must run inside the final actor/SDK-generation fence before committing the original provider session. */
export async function validateListDeletionCompletion(
  tx: Transaction,
  db: Firestore,
  plan: ListDeletionMirrorPlan
): Promise<void> {
  const { header } = await factualListHeader(tx, db, plan),
    completion = header.completion;
  if (
    !completion ||
    completion.inventoryDigest !== header.inventoryDigest ||
    completion.inventoryCount !== header.inventoryCount ||
    completion.headerDigest !== headerIdentity(header) ||
    completion.providerAbsenceDigest !== acknowledgedProjectionDigest(header.providerAbsence) ||
    completion.rootRemovalDigest !== acknowledgedProjectionDigest(header.rootRemoval)
  )
    fail();
}
const listEffectsProgramDigest = (header: Record<string, any>) =>
  acknowledgedProjectionDigest({
    headerDigest: headerIdentity(header),
    inventoryDigest: header.inventoryDigest,
    scopeFingerprint: header.scopeFingerprint,
  });
const listDeletionTargets = (plan: ListDeletionMirrorPlan) =>
  plan.remoteListIds.map((resourceId) => ({
    provider: 'subsplash' as const,
    account: 'app:9XTSHD',
    resourceType: 'list',
    resourceId,
  }));
const listDeletionRequestSteps = (plan: ListDeletionMirrorPlan) =>
  plan.remoteListIds.map((id) => `delete-logical-list:${id}:${providerPayloadFingerprint({ id })}`);
export type ListRootRemovalAcknowledgedInput = {
  ref: DurableJobRef;
  sessionId: string;
  listId: string;
  projectionDigest: string;
} & (
  | {
      requests: Array<Pick<FrozenProjectionRequest, 'step' | 'method' | 'target' | 'fingerprint'>>;
      acknowledgedSteps: string[];
      observations: AcknowledgedProviderObservation[];
    }
  | { candidateId: string; candidateDigest: string; observationScope: string; currentSeal?: Record<string, unknown> }
);
/** Only source-validated original DELETE ACKs plus fresh fixed absence observations authorize this checkpoint. */
export async function prepareListRootRemovalCheckpointFromAcknowledgedRepair(
  tx: Transaction,
  db: Firestore,
  input: ListRootRemovalAcknowledgedInput
): Promise<() => void> {
  if (!digestString(input.sessionId) || !digestString(input.projectionDigest) || !validId(input.listId)) fail();
  const matches = await tx.get(
    db
      .collection(LIST_DELETION_MIRROR_PLANS)
      .where('jobId', '==', input.ref.jobId)
      .where('entity.id', '==', input.listId)
      .limit(2)
  );
  if (matches.size !== 1) fail();
  const plan = matches.docs[0].get('plan') as ListDeletionMirrorPlan;
  if (
    !plan ||
    plan.projectId !== input.ref.projectId ||
    plan.jobId !== input.ref.jobId ||
    plan.planId !== matches.docs[0].id
  )
    fail();
  const { header, intent } = await factualListHeader(tx, db, plan, false);
  if (intent.entity.id !== input.listId) fail();
  const source = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${input.sessionId}`));
  if (
    !source.exists ||
    source.get('intentFingerprint') !== header.intentFingerprint ||
    acknowledgedProjectionDigest(source.data()) !== input.projectionDigest ||
    input.sessionId !==
      providerMutationFingerprint({ projectId: plan.projectId, jobId: plan.jobId, operation: header.operation })
  )
    fail();
  if ('candidateId' in input) {
    const verified = await assertAcknowledgedRepairCandidateVerificationSeal(tx, db, {
      ref: input.ref,
      sessionId: input.sessionId,
      candidateId: input.candidateId,
      candidateDigest: input.candidateDigest,
      projectionDigest: input.projectionDigest,
      observationScope: input.observationScope,
      requiredTargets: listDeletionTargets(plan),
      ...(input.currentSeal ? { currentSeal: input.currentSeal } : {}),
    });
    if (verified.seal.canonicalPath !== `lists/${input.listId}`) fail();
    const root = await tx.get(db.doc(`lists/${input.listId}`)),
      record = await tx.get(listPlanRef(db, plan).collection('rows').doc(providerEdgeKey(root.ref.path)));
    if (
      !record.exists ||
      record.get('kind') !== 'canonical' ||
      record.get('canonicalPath') !== root.ref.path ||
      !digestString(record.get('expectedDocumentDigest')) ||
      (root.exists && acknowledgedProjectionDigest(root.data()) !== record.get('expectedDocumentDigest'))
    )
      fail();
    if (!root.exists) {
      await factualListHeader(tx, db, plan);
      return () => {};
    }
    const held = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${input.sessionId}`)),
      session = { db, id: input.sessionId, scope: held.get('scope'), resources: held.get('resources') };
    const effectsClosed = await prepareCoreListEffectsClosed(tx, session, async () => ({
      sourceProgramDigest: listEffectsProgramDigest(header),
      expectedRequestSteps: listDeletionRequestSteps(plan),
      qualifiedNoSendSteps: [],
    }));
    const providerAbsence = {
      headerDigest: headerIdentity(header),
      absenceDigest: verified.programSealDigest,
      sourceRootDigest: input.projectionDigest,
      sessionId: input.sessionId,
      localOnly: false,
      candidateId: input.candidateId,
      candidateDigest: input.candidateDigest,
      observationScope: input.observationScope,
      programId: verified.programId,
      programSealDigest: verified.programSealDigest,
    };
    const rootRemoval = {
      entityId: input.listId,
      headerDigest: headerIdentity(header),
      inventoryDigest: header.inventoryDigest,
      providerAbsenceDigest: acknowledgedProjectionDigest(providerAbsence),
    };
    return () => {
      effectsClosed.commit();
      tx.update(listPlanRef(db, plan), { providerAbsence, rootRemoval });
    };
  }
  for (const remoteId of plan.remoteListIds) {
    const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list',
        resourceId: remoteId,
      },
      step = `delete-logical-list:${remoteId}:${providerPayloadFingerprint({ id: remoteId })}`,
      fingerprint = publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: { id: remoteId } });
    if (
      !input.requests.some(
        (request) =>
          request.step === step &&
          request.method === 'DELETE' &&
          request.fingerprint === fingerprint &&
          providerMutationFingerprint(request.target) === providerMutationFingerprint(target)
      ) ||
      !input.acknowledgedSteps.includes(step) ||
      !input.observations.some(
        (observation) =>
          observation.provider === 'subsplash' &&
          observation.account === 'app:9XTSHD' &&
          observation.resourceType === 'list' &&
          observation.resourceId === remoteId &&
          observation.state === 'absent'
      )
    )
      fail();
  }
  const proofs = await assertListProviderFacts(tx, db, plan, header, false);
  if (!proofs.length) fail();
  const root = await tx.get(db.doc(`lists/${input.listId}`)),
    record = await tx.get(listPlanRef(db, plan).collection('rows').doc(providerEdgeKey(root.ref.path)));
  if (
    !record.exists ||
    record.get('kind') !== 'canonical' ||
    record.get('canonicalPath') !== root.ref.path ||
    !digestString(record.get('expectedDocumentDigest')) ||
    (root.exists && acknowledgedProjectionDigest(root.data()) !== record.get('expectedDocumentDigest'))
  )
    fail();
  if (!root.exists) {
    await factualListHeader(tx, db, plan);
    return () => {};
  }
  let absenceDigest = acknowledgedProjectionDigest([]);
  for (const proof of proofs) absenceDigest = acknowledgedProjectionDigest([absenceDigest, proof]);
  const providerAbsence = {
      headerDigest: headerIdentity(header),
      absenceDigest,
      sourceRootDigest: input.projectionDigest,
      sessionId: input.sessionId,
      localOnly: false,
    },
    checkpoint = {
      entityId: input.listId,
      headerDigest: headerIdentity(header),
      inventoryDigest: header.inventoryDigest,
      providerAbsenceDigest: acknowledgedProjectionDigest(providerAbsence),
    };
  if (
    (header.providerAbsence &&
      acknowledgedProjectionDigest(header.providerAbsence) !== acknowledgedProjectionDigest(providerAbsence)) ||
    (header.rootRemoval &&
      acknowledgedProjectionDigest(header.rootRemoval) !== acknowledgedProjectionDigest(checkpoint))
  )
    fail();
  const refs = proofs.map((proof) =>
      listPlanRef(db, plan).collection('providerAbsences').doc(providerEdgeKey(proof.remoteId))
    ),
    prior = await tx.getAll(...refs);
  prior.forEach((snapshot, index) => {
    if (
      snapshot.exists &&
      acknowledgedProjectionDigest(snapshot.data()) !== acknowledgedProjectionDigest(proofs[index])
    )
      fail();
  });
  const held = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${input.sessionId}`)),
    session = { db, id: input.sessionId, scope: held.get('scope'), resources: held.get('resources') };
  const effectsClosed = await prepareCoreListEffectsClosed(tx, session, async () => ({
    sourceProgramDigest: listEffectsProgramDigest(header),
    expectedRequestSteps: listDeletionRequestSteps(plan),
    qualifiedNoSendSteps: [],
  }));
  return () => {
    effectsClosed.commit();
    prior.forEach((snapshot, index) => {
      if (!snapshot.exists) tx.create(refs[index], proofs[index]);
    });
    tx.update(listPlanRef(db, plan), { providerAbsence, rootRemoval: checkpoint });
  };
}
