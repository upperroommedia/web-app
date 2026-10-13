import { acknowledgedProjectionDigest as hash } from './acknowledgedProjectionDigest';
import { readSermonDeletionRootMutationTargetsPage } from '../../helpers/sermonDeletionMirrors';
import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  readAcknowledgedProjectionFragments,
  assertAcknowledgedProjectionRequestPrepared,
  reduceCanonicalPrograms,
  reduceVerificationPrograms,
  validateWrite,
  validateVerification,
  type AcknowledgedProjectionRoot,
  type FrozenProjectionRequest,
  type FrozenProjectionWrite,
  type FrozenProviderVerification,
} from './criticalAcknowledgedRepair';
import {
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  type ProviderMutationSession,
  type ProviderMutationResource,
} from './providerMutationGuard';

export const ACKNOWLEDGED_REPAIR_CANDIDATES = 'temporalPublishingAcknowledgedRepairCandidates';
const REQUEST_PAGE_SIZE = 32;
const fail = (): never => {
  throw Object.assign(new Error('Original acknowledged repair evidence is incomplete or changed.'), {
    code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
  });
};

const emptyHash = (): string => hash([]);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sequence = (value: number): string => String(value).padStart(16, '0');
// Only a fixed relationship unlink can preserve content during an original prefix stop.
function isDestructiveRequest(request: FrozenProjectionRequest): boolean {
  if (request.method !== 'DELETE') return false;
  const target = request.target,
    payload = request.payload;
  if (
    !target ||
    target.provider !== 'subsplash' ||
    target.account !== 'app:9XTSHD' ||
    target.resourceType !== 'list-row' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return true;
  const body = payload as Record<string, unknown>;
  return (
    Object.keys(body).sort().join(',') !== 'id,listId' ||
    body.id !== target.resourceId ||
    typeof body.listId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(body.listId)
  );
}

function changesRetainedContent(write: FrozenProjectionWrite): boolean {
  const collection = write.path.split('/')[0];
  if (collection === 'temporalPublishingAudioReplacements') return true;
  if (write.mode === 'delete' && /^(sermons|lists|series|speakers)\/[^/]+$/.test(write.path)) return true;
  if (write.mode === 'set' && /^sermons\/[^/]+$/.test(write.path)) return true;
  const retainedFields = new Set([
    'audioArtifacts',
    'audioStoragePath',
    'sourcePath',
    'finalPath',
    'processedPath',
    'sourceAudioPath',
    'processedAudioPath',
    'finalAudioPath',
    'audioSource',
    'audio',
    'audioFile',
    'storagePath',
  ]);
  return [...Object.keys(write.patch), ...(write.deleteFields ?? [])].some((key) =>
    retainedFields.has(key.split('.')[0])
  );
}

export interface AcknowledgedRepairCandidateStore {
  /** Every private candidate commit must use the current actor/generation/SDK epoch fence. */
  commitCurrent<T>(ref: DurableJobRef, mutate: (transaction: Transaction) => Promise<T>): Promise<T>;
}
export type AcknowledgedRepairCandidateResult = {
  state: 'pending' | 'ready';
  candidateId: string;
  rootDigest: string;
  sourceRootDigest: string;
  phase: 'requests' | 'fragments' | 'root_targets' | 'root_dependency_catalog' | 'ready';
  candidateDigest?: string;
};
export type CandidateRequestEvidence = {
  step: string;
  state: 'acknowledged' | 'rejected_no_effect';
  method: string;
  fingerprint: string;
  claim: string;
  executionId: string;
  sourceRequestPath: string;
  sourceRequestDigest: string;
  factPath: string;
  factDigest: string;
  plannedRequestPath: string;
  plannedRequestDigest: string;
  plannedPageDigest: string;
  resultDigest?: string;
};
export type CandidateCanonicalProgram = {
  canonicalPath: string;
  write: FrozenProjectionWrite;
  baselineCount: number;
  compiledDigest: string;
  orderKey: string;
  dependencyCount: number;
  dependencyCatalogueDigest?: string;
};
export type CandidateVerificationProgram = {
  resourceKey: string;
  verification: FrozenProviderVerification;
  compiledDigest: string;
};
export type AcknowledgedRepairCandidateRoot = {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  sessionId: string;
  sourceRootDigest: string;
  intentFingerprint: string;
  generation: number;
  entity: unknown;
  sessionScopeDigest: string;
  phase: 'requests' | 'fragments' | 'root_targets' | 'root_dependency_catalog' | 'ready';
  requestCursor?: string;
  originalRequestCount: number;
  acknowledgedRequestCount: number;
  rejectedRequestCount: number;
  requestEvidenceDigest: string;
  terminalClaimSetDigest: string;
  fragmentOffset: number;
  fragmentPart: 'requests' | 'writes' | 'verifications';
  itemOffset: number;
  fragmentChainDigest: string;
  plannedRequestCount: number;
  destructiveRequestCount?: number;
  hasDestructiveCanonicalWrites?: boolean;
  programCount: number;
  baselineCount: number;
  verificationCount: number;
  programEvidenceDigest: string;
  sourcePageCount: number;
  sourceRequestCount: number;
  sourceChainDigest: string;
  completesActivity: boolean;
  uiStepIds: string[];
  terminalNoEffectOnly?: true;
  partialStop?: boolean;
  sourceCompletionDigest?: string;
  closedClaimSetDigest?: string;
  closedActualRequestCount?: number;
  dependencyOffset?: number;
  dependencyEligibleAll?: boolean;
  dependencyEligibleAny?: boolean;
  dependencyNewCount?: number;
  rootTargetCursor?: string;
  rootTargetProgramId?: string;
  rootTargetSourceProgramDigest?: string;
  rootTargetSourceCount?: number;
  rootTargetReadCount?: number;
  rootTargetComplete?: boolean;
  rootDependencyCatalogCursor?: string;
  rootDependencyCatalogueCount?: number;
  rootDependencyCatalogueDigest?: string;
};

const result = (candidateId: string, root: AcknowledgedRepairCandidateRoot): AcknowledgedRepairCandidateResult => ({
  state: root.phase === 'ready' ? 'ready' : 'pending',
  candidateId,
  rootDigest: root.sourceRootDigest,
  sourceRootDigest: root.sourceRootDigest,
  phase: root.phase,
  ...(root.phase === 'ready' ? { candidateDigest: hash(root) } : {}),
});
const verificationKey = (value: FrozenProviderVerification): string =>
  providerMutationFingerprint([value.provider, value.account, value.resourceType, value.resourceId]);

/** Compile one bounded piece of original evidence. No provider observation, GET, or
 * operator assertion can turn an unknown original RPC into an acknowledgement here.
 * Only private candidate records are written; canonical data is never touched.
 */
export async function compileAcknowledgedRepairCandidatePage(
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  store: AcknowledgedRepairCandidateStore
): Promise<AcknowledgedRepairCandidateResult> {
  if (!sha(sessionId) || !ref.projectId || !ref.jobId || typeof store.commitCurrent !== 'function') return fail();
  return store.commitCurrent(ref, async (tx) => {
    const sourceRef = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`);
    const initial = await tx.get(sourceRef);
    // The backend validates the root even for an empty window at the end of its catalog.
    const rootWindow = await readAcknowledgedProjectionFragments(tx, db, ref, sessionId, initial.get('pageCount'), 1);
    const source: AcknowledgedProjectionRoot = rootWindow.root;
    const sourceRootDigest = hash(source);
    const [intentSnapshot, jobSnapshot, heldSnapshot] = await Promise.all([
      tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
      tx.get(db.doc(`durableJobs/${ref.jobId}`)),
      tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)),
    ]);
    const intent = intentSnapshot.data(),
      job = jobSnapshot.data(),
      held = heldSnapshot.data();
    if (
      !intent ||
      !job ||
      !held ||
      intent.projectId !== ref.projectId ||
      intent.jobId !== ref.jobId ||
      hash(intent) !== source.intentFingerprint ||
      job.projectId !== ref.projectId ||
      job.jobId !== ref.jobId ||
      job.kind !== intent.kind ||
      job.generation !== intent.generation ||
      !Number.isSafeInteger(intent.generation) ||
      intent.generation < 1 ||
      hash(job.entity) !== hash(intent.entity) ||
      held.scope?.projectId !== ref.projectId ||
      held.scope?.jobId !== ref.jobId ||
      held.scope?.operation !== source.operation ||
      !['active', 'committed'].includes(held.state) ||
      !Array.isArray(held.resources)
    )
      return fail();
    const sessionScopeDigest = hash({ scope: held.scope, resources: held.resources });
    // A changed source root starts a distinct candidate; old fragments are retained for audit.
    const candidateId = hash([ref.projectId, ref.jobId, sessionId, sourceRootDigest]);
    const candidateRef = db.collection(ACKNOWLEDGED_REPAIR_CANDIDATES).doc(candidateId);
    const current = await tx.get(candidateRef);
    let root: AcknowledgedRepairCandidateRoot = current.exists
      ? (current.data() as AcknowledgedRepairCandidateRoot)
      : {
          schemaVersion: 1,
          ...ref,
          sessionId,
          sourceRootDigest,
          intentFingerprint: source.intentFingerprint,
          generation: intent.generation,
          entity: intent.entity,
          sessionScopeDigest,
          phase: 'requests',
          originalRequestCount: 0,
          acknowledgedRequestCount: 0,
          rejectedRequestCount: 0,
          requestEvidenceDigest: emptyHash(),
          terminalClaimSetDigest: providerMutationClaimSetSeed(sessionId),
          fragmentOffset: 0,
          fragmentPart: 'requests',
          itemOffset: 0,
          fragmentChainDigest: emptyHash(),
          plannedRequestCount: 0,
          destructiveRequestCount: 0,
          hasDestructiveCanonicalWrites: [
            'sermon.delete',
            'list.delete',
            'series.delete',
            'speaker.delete',
            'image.delete',
            'sermon.unpublish',
          ].includes(intent.kind),
          programCount: 0,
          baselineCount: 0,
          verificationCount: 0,
          programEvidenceDigest: emptyHash(),
          sourcePageCount: source.pageCount,
          sourceRequestCount: source.requestCount,
          sourceChainDigest: source.chainDigest,
          completesActivity: source.completesActivity,
          uiStepIds: [...source.uiStepIds],
        };
    if (
      root.schemaVersion !== 1 ||
      root.projectId !== ref.projectId ||
      root.jobId !== ref.jobId ||
      root.sessionId !== sessionId ||
      root.sourceRootDigest !== sourceRootDigest ||
      root.intentFingerprint !== source.intentFingerprint ||
      root.generation !== intent.generation ||
      hash(root.entity) !== hash(intent.entity) ||
      root.sessionScopeDigest !== sessionScopeDigest ||
      !['requests', 'fragments', 'root_targets', 'root_dependency_catalog', 'ready'].includes(root.phase)
    )
      return fail();
    const pending: Array<() => void> = [];
    const originalRequests = db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`).collection('requests');
    const requestIndex = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`).collection('requestIndex');
    const evidenceRef = (step: string) =>
      candidateRef.collection('requestEvidence').doc(providerMutationFingerprint(step));

    if (root.phase === 'requests') {
      let query = originalRequests.orderBy(FieldPath.documentId()).limit(REQUEST_PAGE_SIZE);
      if (root.requestCursor) query = query.startAfter(root.requestCursor);
      const page = await tx.get(query);
      const session: ProviderMutationSession = { db, id: sessionId, scope: held.scope, resources: held.resources };
      // This bounded validator reads the exact immutable original HTTP fact for each claim.
      await validateProviderMutationOriginalCompletion(tx, session, page.docs);
      const keys = page.docs.map((doc) => {
        const data = doc.data();
        if (
          typeof data.step !== 'string' ||
          doc.id !== providerMutationFingerprint(data.step) ||
          !['acknowledged', 'rejected_no_effect'].includes(data.state) ||
          !['POST', 'PATCH', 'PUT', 'DELETE'].includes(data.method) ||
          !sha(data.fingerprint) ||
          typeof data.claim !== 'string' ||
          !data.claim ||
          typeof data.executionId !== 'string' ||
          !data.executionId
        )
          return fail();
        return {
          doc,
          data,
          index: requestIndex.doc(doc.id),
          fact: db
            .collection(PROVIDER_MUTATION_FACTS)
            .doc(providerMutationFingerprint([sessionId, data.step, data.claim])),
        };
      });
      const [indices, facts] = keys.length
        ? await Promise.all([tx.getAll(...keys.map((key) => key.index)), tx.getAll(...keys.map((key) => key.fact))])
        : [[], []];
      for (let index = 0; index < keys.length; index++) {
        const { doc, data } = keys[index],
          plannedSnapshot = indices[index],
          fact = facts[index];
        const planned = plannedSnapshot.get('request') as FrozenProjectionRequest;
        if (
          !plannedSnapshot.exists ||
          plannedSnapshot.get('intentFingerprint') !== source.intentFingerprint ||
          plannedSnapshot.get('ready') !== true ||
          !sha(plannedSnapshot.get('pageDigest')) ||
          !sha(plannedSnapshot.get('readyPageDigest')) ||
          !planned ||
          planned.step !== data.step ||
          planned.method !== data.method ||
          planned.fingerprint !== data.fingerprint
        )
          return fail();
        await assertAcknowledgedProjectionRequestPrepared(tx, session, planned);
        if (data.state === 'rejected_no_effect') {
          const original = fact.get('evidence');
          if (
            original?.transport !== 'original_http_response' ||
            !Number.isInteger(original.status) ||
            original.status < 400 ||
            original.status >= 500 ||
            typeof original.providerCode !== 'string' ||
            !original.providerCode
          )
            return fail();
        }
        const record: CandidateRequestEvidence = {
          step: data.step,
          state: data.state,
          method: data.method,
          fingerprint: data.fingerprint,
          claim: data.claim,
          executionId: data.executionId,
          sourceRequestPath: doc.ref.path,
          sourceRequestDigest: hash(data),
          factPath: fact.ref.path,
          factDigest: hash(fact.data()),
          plannedRequestPath: plannedSnapshot.ref.path,
          plannedRequestDigest: hash(planned),
          plannedPageDigest: plannedSnapshot.get('pageDigest'),
          ...(data.state === 'acknowledged' ? { resultDigest: providerMutationFingerprint(data.result) } : {}),
        };
        pending.push(() => tx.create(evidenceRef(data.step), record));
        root = {
          ...root,
          originalRequestCount: root.originalRequestCount + 1,
          acknowledgedRequestCount: root.acknowledgedRequestCount + Number(data.state === 'acknowledged'),
          rejectedRequestCount: root.rejectedRequestCount + Number(data.state === 'rejected_no_effect'),
          requestEvidenceDigest: hash([
            root.requestEvidenceDigest,
            doc.id,
            record.sourceRequestDigest,
            record.factDigest,
            record.plannedRequestDigest,
          ]),
          terminalClaimSetDigest: providerMutationClaimSetFold(root.terminalClaimSetDigest, {
            requestId: doc.id,
            step: data.step,
            method: data.method,
            fingerprint: data.fingerprint,
            claim: data.claim,
            executionId: data.executionId,
            state: data.state,
          }),
          requestCursor: doc.id,
        };
      }
      if (page.size < REQUEST_PAGE_SIZE) {
        if (!root.originalRequestCount || root.originalRequestCount > source.requestCount) return fail();
        root = { ...root, phase: 'fragments' };
      }
    } else if (root.phase === 'fragments') {
      if (root.fragmentOffset < source.pageCount) {
        const window = await readAcknowledgedProjectionFragments(tx, db, ref, sessionId, root.fragmentOffset, 1);
        if (hash(window.root) !== sourceRootDigest || window.fragments.length !== 1) return fail();
        const fragment = window.fragments[0],
          plan = fragment.plan;
        if (
          fragment.index !== root.fragmentOffset ||
          fragment.digest !== hash(plan) ||
          plan.projectId !== ref.projectId ||
          plan.jobId !== ref.jobId ||
          plan.sessionId !== sessionId ||
          plan.operation !== source.operation ||
          plan.intentFingerprint !== source.intentFingerprint ||
          !Array.isArray(plan.requests) ||
          !Array.isArray(plan.writes) ||
          !Array.isArray(plan.verifications)
        )
          return fail();
        const evidenceCache = new Map<string, CandidateRequestEvidence | undefined>();
        const preserveTargetAuthority = (target: ProviderMutationResource): void => {
          if (held.resources.some((resource: unknown) => hash(resource) === hash(target))) return;
          const authority = plan.targetAuthorities?.find(
            (value) =>
              hash(value.target) === hash(target) &&
              sha(value.proofHash) &&
              ['planned', 'list_row', 'created_overflow'].includes(value.kind) &&
              held.resources.some((resource: unknown) => hash(resource) === hash(value.rootResource))
          );
          if (!authority) return fail();
          const targetRef = candidateRef.collection('targetAuthorities').doc(providerMutationFingerprint(target));
          pending.push(() =>
            tx.set(targetRef, { authority, digest: hash(authority), sourceFragmentDigest: fragment.digest })
          );
        };
        const eligible = async (projection: {
          requiredSteps?: string[];
          requiredAnySteps?: string[];
        }): Promise<boolean> => {
          if (!root.acknowledgedRequestCount) return false;
          if (root.acknowledgedRequestCount === source.requestCount) return true;
          const required = projection.requiredSteps ?? (projection.requiredAnySteps ? [] : undefined);
          if (!required && root.acknowledgedRequestCount !== source.requestCount) return false;
          const steps = [...new Set([...(required ?? []), ...(projection.requiredAnySteps ?? [])])];
          const unread = steps.filter((step) => !evidenceCache.has(step));
          if (unread.length) {
            const records = await tx.getAll(...unread.map(evidenceRef));
            records.forEach((snapshot, index) =>
              evidenceCache.set(
                unread[index],
                snapshot.exists ? (snapshot.data() as CandidateRequestEvidence) : undefined
              )
            );
          }
          return (
            (required ?? []).every((step) => evidenceCache.get(step)?.state === 'acknowledged') &&
            (!projection.requiredAnySteps ||
              projection.requiredAnySteps.some((step) => evidenceCache.get(step)?.state === 'acknowledged'))
          );
        };
        if (root.fragmentPart === 'requests') {
          const selected = plan.requests.slice(root.itemOffset, root.itemOffset + REQUEST_PAGE_SIZE);
          const [indices, prior] = selected.length
            ? await Promise.all([
                tx.getAll(...selected.map((request) => requestIndex.doc(providerMutationFingerprint(request.step)))),
                tx.getAll(
                  ...selected.map((request) =>
                    candidateRef.collection('plannedRequests').doc(providerMutationFingerprint(request.step))
                  )
                ),
              ])
            : [[], []];
          selected.forEach((request, index) => {
            if (
              indices[index].get('intentFingerprint') !== source.intentFingerprint ||
              hash(indices[index].get('request')) !== hash(request)
            )
              return fail();
            if (request.target) preserveTargetAuthority(request.target);
            const digest = hash(request);
            if (prior[index].exists) {
              if (prior[index].get('digest') !== digest) return fail();
            } else {
              if (indices[index].get('pageDigest') !== fragment.digest) return fail();
              root = {
                ...root,
                plannedRequestCount: root.plannedRequestCount + 1,
                destructiveRequestCount: (root.destructiveRequestCount ?? 0) + Number(isDestructiveRequest(request)),
              };
              pending.push(() => tx.create(prior[index].ref, { step: request.step, digest }));
            }
          });
          root = { ...root, itemOffset: root.itemOffset + selected.length };
          if (root.itemOffset === plan.requests.length) root = { ...root, fragmentPart: 'writes', itemOffset: 0 };
        } else if (root.fragmentPart === 'writes') {
          const write = plan.writes[root.itemOffset];
          if (write && changesRetainedContent(write)) root = { ...root, hasDestructiveCanonicalWrites: true };
          if (!write) {
            root = { ...root, fragmentPart: 'verifications', itemOffset: 0 };
          } else {
            validateWrite(write);
            const steps = [...new Set([...(write.requiredSteps ?? []), ...(write.requiredAnySteps ?? [])])];
            const offset = root.dependencyOffset ?? 0,
              selected = steps.slice(offset, offset + REQUEST_PAGE_SIZE);
            const [evidences, indices] = selected.length
              ? await Promise.all([
                  tx.getAll(...selected.map(evidenceRef)),
                  tx.getAll(...selected.map((step) => requestIndex.doc(providerMutationFingerprint(step)))),
                ])
              : [[], []];
            let all = root.dependencyEligibleAll ?? true,
              any = root.dependencyEligibleAny ?? false;
            const dependencies = new Map<
              string,
              { target: ProviderMutationResource; verifierKey: string; requestStep: string }
            >();
            for (let index = 0; index < selected.length; index++) {
              const step = selected[index],
                evidence = evidences[index].data() as CandidateRequestEvidence | undefined,
                planned = indices[index].get('request') as FrozenProjectionRequest;
              if (
                !planned ||
                planned.step !== step ||
                indices[index].get('intentFingerprint') !== source.intentFingerprint
              )
                fail();
              const positive = evidence?.state === 'acknowledged';
              if ((write.requiredSteps ?? []).includes(step)) all &&= positive;
              if ((write.requiredAnySteps ?? []).includes(step)) any ||= positive;
              if (positive && planned.target) {
                const verifierKey = providerMutationFingerprint([
                  planned.target.provider,
                  planned.target.account,
                  planned.target.resourceType,
                  planned.target.resourceId,
                ]);
                dependencies.set(verifierKey, { target: planned.target, verifierKey, requestStep: step });
              }
              // Older trusted producers captured the exact held resource in their presend
              // verifier, while the request retained its original target-bound hash only.
              // Such writes still require those eligible original verifier dependencies.
              if (positive && !planned.target)
                for (const verification of plan.verifications) {
                  if (
                    !(verification.requiredSteps ?? plan.requests.map((value) => value.step)).includes(step) ||
                    !(await eligible(verification))
                  )
                    continue;
                  validateVerification(verification);
                  const target = {
                    provider: verification.provider,
                    account: verification.account,
                    resourceType: verification.resourceType,
                    resourceId: verification.resourceId,
                  };
                  preserveTargetAuthority(target);
                  const verifierKey = providerMutationFingerprint([
                    target.provider,
                    target.account,
                    target.resourceType,
                    target.resourceId,
                  ]);
                  dependencies.set(verifierKey, { target, verifierKey, requestStep: step });
                }
            }
            const programRef = candidateRef.collection('programs').doc(providerMutationFingerprint(write.path));
            const entries = [...dependencies.values()],
              existing = entries.length
                ? await tx.getAll(
                    ...entries.map((value) => programRef.collection('dependencies').doc(value.verifierKey))
                  )
                : [];
            let newCount = root.dependencyNewCount ?? 0;
            entries.forEach((value, index) => {
              if (existing[index].exists) {
                if (hash(existing[index].get('target')) !== hash(value.target)) fail();
              } else {
                newCount++;
                pending.push(() => tx.create(existing[index].ref, { ...value, digest: hash(value.target) }));
              }
            });
            const next = offset + selected.length;
            if (next < steps.length)
              root = {
                ...root,
                dependencyOffset: next,
                dependencyEligibleAll: all,
                dependencyEligibleAny: any,
                dependencyNewCount: newCount,
              };
            else {
              const accepted = steps.length
                ? all && (!write.requiredAnySteps || any)
                : root.acknowledgedRequestCount === source.requestCount;
              if (accepted) {
                const previous = await tx.get(programRef),
                  prior = previous.exists ? (previous.data() as CandidateCanonicalProgram) : undefined;
                if (
                  prior &&
                  (prior.canonicalPath !== write.path || prior.compiledDigest !== hash([prior.write, prior.orderKey]))
                )
                  fail();
                const composed = reduceCanonicalPrograms(prior ? [prior.write, write] : [write]);
                if (composed.length !== 1 || composed[0].write.path !== write.path) fail();
                const writeIndex = root.itemOffset,
                  orderKey = prior?.orderKey ?? `${sequence(fragment.index)}-${sequence(writeIndex)}`;
                const record: CandidateCanonicalProgram = {
                  canonicalPath: write.path,
                  write: composed[0].write,
                  baselineCount: (prior?.baselineCount ?? 0) + 1,
                  orderKey,
                  dependencyCount: (prior?.dependencyCount ?? 0) + newCount,
                  compiledDigest: hash([composed[0].write, orderKey]),
                };
                if (!prior)
                  pending.push(() =>
                    tx.create(candidateRef.collection('programOrder').doc(orderKey), {
                      programId: programRef.id,
                      canonicalPath: write.path,
                      orderKey,
                    })
                  );
                pending.push(() =>
                  tx.create(
                    programRef.collection('baselines').doc(`${sequence(fragment.index)}-${sequence(writeIndex)}`),
                    {
                      fragmentIndex: fragment.index,
                      fragmentDigest: fragment.digest,
                      writeIndex,
                      write,
                      digest: hash(write),
                    }
                  )
                );
                pending.push(() => tx.set(programRef, record));
                root = {
                  ...root,
                  programCount: root.programCount + Number(!prior),
                  baselineCount: root.baselineCount + 1,
                  programEvidenceDigest: hash([
                    root.programEvidenceDigest,
                    fragment.index,
                    writeIndex,
                    hash(write),
                    record.compiledDigest,
                  ]),
                };
              }
              const {
                dependencyOffset: _offset,
                dependencyEligibleAll: _all,
                dependencyEligibleAny: _any,
                dependencyNewCount: _count,
                ...remaining
              } = root;
              root = { ...remaining, itemOffset: root.itemOffset + 1 };
              if (root.itemOffset === plan.writes.length)
                root = { ...root, fragmentPart: 'verifications', itemOffset: 0 };
            }
          }
        } else {
          const selected = plan.verifications.slice(root.itemOffset, root.itemOffset + REQUEST_PAGE_SIZE);
          const programs = new Map<string, CandidateVerificationProgram | undefined>();
          const keys = [...new Set(selected.map(verificationKey))];
          const previous = keys.length
            ? await tx.getAll(...keys.map((key) => candidateRef.collection('verifications').doc(key)))
            : [];
          previous.forEach((snapshot, index) => {
            const record = snapshot.exists ? (snapshot.data() as CandidateVerificationProgram) : undefined;
            if (record && (record.resourceKey !== keys[index] || record.compiledDigest !== hash(record.verification)))
              return fail();
            programs.set(keys[index], record);
          });
          for (const verification of selected) {
            validateVerification(verification);
            if (!(await eligible(verification))) continue;
            preserveTargetAuthority({
              provider: verification.provider,
              account: verification.account,
              resourceType: verification.resourceType,
              resourceId: verification.resourceId,
            });
            const key = verificationKey(verification),
              prior = programs.get(key);
            const composed = reduceVerificationPrograms(prior ? [prior.verification, verification] : [verification]);
            if (composed.length !== 1) return fail();
            programs.set(key, { resourceKey: key, verification: composed[0], compiledDigest: hash(composed[0]) });
            if (!prior) root = { ...root, verificationCount: root.verificationCount + 1 };
          }
          programs.forEach((record, key) => {
            if (record) pending.push(() => tx.set(candidateRef.collection('verifications').doc(key), record));
          });
          root = { ...root, itemOffset: root.itemOffset + selected.length };
          if (root.itemOffset === plan.verifications.length)
            root = {
              ...root,
              fragmentOffset: root.fragmentOffset + 1,
              fragmentChainDigest: hash([root.fragmentChainDigest, fragment.index, fragment.digest]),
              fragmentPart: 'requests',
              itemOffset: 0,
            };
        }
      } else {
        const count = (await tx.get(originalRequests.count())).data().count;
        if (
          count !== root.originalRequestCount ||
          root.plannedRequestCount !== source.requestCount ||
          root.fragmentChainDigest !== source.chainDigest ||
          !root.originalRequestCount ||
          root.acknowledgedRequestCount + root.rejectedRequestCount !== root.originalRequestCount
        )
          return fail();
        const entity = intent.entity as { type?: string; id?: string };
        const rootProgramId = providerMutationFingerprint(`sermons/${entity?.id}`),
          rootProgram =
            entity?.type === 'sermon' && intent.kind === 'sermon.delete'
              ? await tx.get(candidateRef.collection('programs').doc(rootProgramId))
              : undefined;
        if (rootProgram?.exists && rootProgram.get('write.mode') === 'delete') {
          if (
            root.acknowledgedRequestCount !== source.requestCount ||
            root.originalRequestCount !== source.requestCount ||
            root.rejectedRequestCount
          )
            fail();
          root = { ...root, phase: 'root_targets', rootTargetProgramId: rootProgramId, rootTargetReadCount: 0 };
        } else
          root = {
            ...root,
            ...(held.effectsClosed === true &&
            sha(held.effectsClosedClaimSetDigest) &&
            Number.isSafeInteger(held.effectsClosedActualRequestCount)
              ? {
                  closedClaimSetDigest: held.effectsClosedClaimSetDigest,
                  closedActualRequestCount: held.effectsClosedActualRequestCount,
                }
              : {}),
            phase: 'ready',
            ...(!root.acknowledgedRequestCount ? { terminalNoEffectOnly: true as const } : {}),
            partialStop:
              root.originalRequestCount !== source.requestCount ||
              root.rejectedRequestCount > 0 ||
              source.completesActivity === false,
            sourceCompletionDigest: hash([
              root.requestEvidenceDigest,
              root.originalRequestCount,
              root.acknowledgedRequestCount,
              root.rejectedRequestCount,
            ]),
          };
      }
    } else if (root.phase === 'root_targets') {
      const entity = intent.entity as { type: string; id: string },
        rootTargetProgramId = root.rootTargetProgramId;
      if (intent.kind !== 'sermon.delete' || entity.type !== 'sermon' || !rootTargetProgramId) return fail();
      const page = await readSermonDeletionRootMutationTargetsPage(tx, db, {
        ref,
        sermonId: entity.id,
        cursor: root.rootTargetCursor,
        limit: 32,
      });
      if (
        page.sourceRequestCount !== source.requestCount ||
        (root.rootTargetSourceProgramDigest && root.rootTargetSourceProgramDigest !== page.sourceProgramDigest) ||
        (root.rootTargetSourceCount !== undefined && root.rootTargetSourceCount !== page.sourceRequestCount)
      )
        fail();
      const programRef = candidateRef.collection('programs').doc(rootTargetProgramId),
        program = (await tx.get(programRef)).data() as CandidateCanonicalProgram;
      if (
        !program ||
        program.write.mode !== 'delete' ||
        program.canonicalPath !== `sermons/${entity.id}` ||
        program.compiledDigest !== hash([program.write, program.orderKey])
      )
        fail();
      const dependencies = new Map<
        string,
        { target: ProviderMutationResource; verifierKey: string; requestStep: string }
      >();
      const evidences = page.targets.length
        ? await tx.getAll(...page.targets.map((value) => evidenceRef(value.requestStep)))
        : [];
      page.targets.forEach((value, index) => {
        if (evidences[index].get('state') !== 'acknowledged') fail();
        const verifierKey = providerMutationFingerprint([
          value.target.provider,
          value.target.account,
          value.target.resourceType,
          value.target.resourceId,
        ]);
        dependencies.set(verifierKey, { ...value, verifierKey });
      });
      const entries = [...dependencies.values()],
        previous = entries.length
          ? await tx.getAll(...entries.map((value) => programRef.collection('dependencies').doc(value.verifierKey)))
          : [];
      let added = 0;
      entries.forEach((value, index) => {
        if (previous[index].exists) {
          if (hash(previous[index].get('target')) !== hash(value.target)) fail();
        } else {
          added++;
          pending.push(() => tx.create(previous[index].ref, { ...value, digest: hash(value.target) }));
        }
      });
      pending.push(() => tx.set(programRef, { ...program, dependencyCount: program.dependencyCount + added }));
      root = {
        ...root,
        rootTargetReadCount: (root.rootTargetReadCount ?? 0) + page.targets.length,
        rootTargetSourceProgramDigest: page.sourceProgramDigest,
        rootTargetSourceCount: page.sourceRequestCount,
        ...(page.nextCursor ? { rootTargetCursor: page.nextCursor } : {}),
      };
      if (!page.nextCursor) {
        if (root.rootTargetReadCount !== source.requestCount) fail();
        root = {
          ...root,
          rootTargetComplete: true,
          phase: 'root_dependency_catalog',
          rootDependencyCatalogueCount: 0,
          rootDependencyCatalogueDigest: hash([]),
        };
      }
    } else if (root.phase === 'root_dependency_catalog') {
      const programId = root.rootTargetProgramId;
      if (!programId) return fail();
      const programRef = candidateRef.collection('programs').doc(programId),
        program = (await tx.get(programRef)).data() as CandidateCanonicalProgram;
      let query = programRef.collection('dependencies').orderBy(FieldPath.documentId()).limit(32);
      if (root.rootDependencyCatalogCursor) query = query.startAfter(root.rootDependencyCatalogCursor);
      const page = await tx.get(query);
      let count = root.rootDependencyCatalogueCount ?? 0,
        digest = root.rootDependencyCatalogueDigest ?? hash([]);
      for (const dependency of page.docs) {
        const target = dependency.get('target') as ProviderMutationResource;
        if (
          dependency.id !==
            providerMutationFingerprint([target.provider, target.account, target.resourceType, target.resourceId]) ||
          dependency.get('digest') !== hash(target)
        )
          fail();
        count++;
        digest = hash([digest, dependency.id, hash(target)]);
      }
      root = {
        ...root,
        rootDependencyCatalogueCount: count,
        rootDependencyCatalogueDigest: digest,
        ...(page.size === 32 ? { rootDependencyCatalogCursor: page.docs[page.docs.length - 1].id } : {}),
      };
      if (page.size < 32) {
        if (count !== program.dependencyCount || root.rootTargetComplete !== true) fail();
        pending.push(() => tx.set(programRef, { ...program, dependencyCatalogueDigest: digest }));
        root = {
          ...root,
          phase: 'ready',
          partialStop: source.completesActivity === false,
          ...(held.effectsClosed === true &&
          sha(held.effectsClosedClaimSetDigest) &&
          Number.isSafeInteger(held.effectsClosedActualRequestCount)
            ? {
                closedClaimSetDigest: held.effectsClosedClaimSetDigest,
                closedActualRequestCount: held.effectsClosedActualRequestCount,
              }
            : {}),
          sourceCompletionDigest: hash([
            root.requestEvidenceDigest,
            root.originalRequestCount,
            root.acknowledgedRequestCount,
            root.rejectedRequestCount,
          ]),
        };
      }
    } else {
      const count = (await tx.get(originalRequests.count())).data().count;
      if (count !== root.originalRequestCount || root.fragmentChainDigest !== source.chainDigest) return fail();
      return result(candidateId, root);
    }
    // Complete all evidence reads before any candidate write. The callback's SDK fence
    // commits these private records atomically with its progress cursor.
    pending.forEach((write) => write());
    tx.set(candidateRef, root);
    return result(candidateId, root);
  });
}
